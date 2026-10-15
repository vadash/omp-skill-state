# omp-skill-state

An [omp](https://omp.sh) plugin that runs a procedural skill against an explicit execution state instead of a growing transcript. The design is in `docs/spec.md`; the vocabulary is in `CONTEXT.md`.

Status: implemented and verified against a long real session (`docs/verification.md`). A procedure skill engages and disengages; the model's `state_update` calls are validated, merged and persisted as state messages, and invalid patches block the step and degrade after `retries` failures. While engaged, every provider call sees only the head (the operating rules, the procedure spec, the state core and the scratch state) and the tail: the most recent stored messages behind it — the current turn among them — held under a fraction-of-window prompt budget, each tailed tool result carrying a pair tag that a per-call window notice lists oldest first; a step whose tail is empty sees the head plus a one-line degradation notice, never ordinary history. When their thresholds are met, two per-call policy asks ride too: the idle ask once the state has stood still for `idleSteps` steps — a reminder that never ends the run — and the consolidation ask while the state is over its `stateBytes` cap; the stored transcript stays complete. Compaction while engaged is owned by the runtime: the summary is the state, the cut is the current step, and no summarizer call is made.

The universal redesign (ADR 0010-0012, spec section 20) has landed its bounded tail, the pair tags and the window notice; what remains decided and not yet implemented is recall for what the tail evicts and the cacheable prefix that runs through the tail.

## Layout

| Path | Role |
| --- | --- |
| `package.json` | Plugin manifest: `"omp": { "extensions": ["./src/index.ts"] }` |
| `src/index.ts` | The extension: a thin harness adapter over the modules below. omp imports the TypeScript directly; there is no build step. |
| `src/branch.ts` | Pure reads over the stored branch: the re-derive scan and the compaction cut. |
| `src/procedure.ts` | The procedure record and the step policy: patch outcomes, idle and retry counters, head and compaction construction. |
| `src/messages.ts` | The message vocabulary: the head message types (rules, procedure spec, state core, scratch), the state renderer, the core and scratch state builders, and the two nudge message builders. |
| `test/fake-session.ts` | The fake omp session the adapter tests drive: branch, delivery timing, sends and notices. |
| `test/harness.ts` | The adapter suites' shared harness: per-suite skill fixtures, the engaged/projecting session builders, the assertion builders. |
| `test/entries.ts` | One home for the stored-branch entry builders: invocation, spec, state pair, procedure branch, assistant. |
| `test/*.test.ts` | Unit tests for the step policy, the branch reads, the state merge and the projection; `test/adapter-*.test.ts` drive the factory through the fake session, one file per concern (lifecycle, patch channel, compaction, projection seam) |
| `skills/zstate/` | Bundled mode-entry procedure skill (`SKILL.md` + `state.schema.json`): it carries no task of its own; the task is the text given with the invocation, and `disable-model-invocation` keeps it user-invoked only |
| `docs/spec.md`, `docs/adr/`, `CONTEXT.md` | Design, decisions, glossary |
| `docs/verification.md`, `verification/` | Run G's acceptance evidence: the session analyzer, the compact-early compaction config, and the `capture/` plugin that records provider request bodies when `SKILL_STATE_CAPTURE_DIR` is set |

## Develop

You need [bun](https://bun.sh) and omp (`omp --version`).

```sh
bun install        # dev dependencies: extension types, tsc, bun test types
bun run typecheck  # tsc --noEmit
bun test           # unit tests
```

`bun install` reports two blocked postinstall scripts (`onnxruntime-node`, `protobufjs`). They belong to transitive dependencies of the types package and are not needed. Leave them blocked.

## Install into omp

Link this checkout as a development plugin:

```sh
omp plugin link "C:\projects\_llm\omp-skill-state"
omp plugin list     # omp-skill-state, enabled
omp plugin doctor   # 0 errors
```

`link` creates a junction at `~/.omp/plugins/node_modules/omp-skill-state` and an enabled entry in `~/.omp/plugins/omp-plugins.lock.json`. Changes to `src/index.ts` take effect at the next session start. Remove the link with `omp plugin uninstall omp-skill-state`.

Invoke a procedure skill (a skill with a `state.schema.json`) in the main agent and it engages. The bundled `zstate` skill takes its task from the invocation text, e.g. `/skill:zstate read skill://implement and work on issue 67`:

```
skill-state: procedure "zstate" engaged
skill-state: history is hidden from the model while engaged; finish with /new
```

The runtime disengages on `/new`, `/clear`, a session switch or fork, a branch, or tree navigation, with one notice naming the trigger:

```
skill-state: procedure "zstate" disengaged (/new)
```

Skills without a state schema, model-initiated skill reads, and subagent sessions stay silent. Engagement is keyed by session id, so two sessions in one process never see each other's procedures.

## Extension types

`src/index.ts` imports `ExtensionAPI` and friends as types only, plus two value imports: `Text` from `@oh-my-pi/pi-coding-agent` (the state message renderer) and `InternalUrlRouter` from `@oh-my-pi/pi-coding-agent/internal-urls` (in `src/state.ts`, to resolve `skill://` paths). At load time omp rewrites every `@oh-my-pi/pi-coding-agent/*` import from a plugin onto its own bundled copy (the plugin compat layer in the harness, `legacy-pi-compat`), so there is still no separate runtime dependency to install.

The types come from the published `@oh-my-pi/pi-coding-agent` package, pinned to the version of the installed omp (`omp --version`). The published package ships `dist/types/*.d.ts`, which keeps `tsc` fast and independent of the harness source.

### When the published types lag the local checkout

The spec names a `file:` dependency on the harness checkout at `C:\projects\_llm\oh-my-pi\packages\coding-agent` as the fallback:

```
"devDependencies": {
  "@oh-my-pi/pi-coding-agent": "file:../oh-my-pi/packages/coding-agent"
}
```

This does not work as-is. Two reasons, both verified:

1. The checkout is a workspace member. Its dependencies use `catalog:` specifiers, which bun resolves only inside the monorepo. From this repo, `bun install` fails with `@opentelemetry/resources@catalog: failed to resolve` and similar errors.
2. The checkout's `types` entry points at `src/index.ts`, not at `.d.ts` files. `tsc` would then check the harness source, which needs the monorepo's own dependencies and tsconfig.

The checkout is read-only, so installing its dependencies in place is not an option. Do this instead:

- Bump the pin to the newest published version first. Publishes track the checkout closely; `npm view @oh-my-pi/pi-coding-agent version` shows the latest.
- Only a tarball packed from a copy of the monorepo, after its own install and build, could serve a `file:` dependency. That path is not verified here.

## Authoring a procedure skill

A procedure skill is an ordinary skill that declares a state schema: a `state.schema.json` shipped beside `SKILL.md` in the skill's directory. Only skills with a schema start a procedure; a skill without a `state.schema.json` is an ordinary skill and never engages. The schema is a JSON Schema subset whose top level must be an object, with the types `string`, `number`, `boolean`, `array`, `object` and `null`; `additionalProperties` accepts `true`, `false` or a schema, and defaults to `true`, so a run can carry keys the schema does not name. Author it once per domain, not per task:

```json
{
  "type": "object",
  "properties": {
    "working_dir": { "type": "string" },
    "discovered_flags": { "type": "array", "items": { "type": "string" } }
  },
  "additionalProperties": true,
  "x-state": { "volatile": ["discovered_flags"] }
}
```

The schema declares the execution state the procedure keeps. The model writes it only through `state_update` patches: a non-null value sets the key, a `null` value deletes it whatever its declared type, the root operator `{"$append": {"key": [ ... ]}}` appends items onto an array key instead of setting it whole, and `{"$remove": {"key": [ ... ]}}` removes matching items from an array key by value. Declared keys are checked against their declared types; undeclared keys are accepted while `additionalProperties` is `true` or absent, and a schema as `additionalProperties` validates every undeclared member against itself, member path in the error; an invalid patch changes nothing. The optional `x-state` block tunes the step policy per skill: `observationBytes`, `promptBudgetPercent`, `evictionChunkPercent`, `stateBytes`, `idleSteps`, `retries` and `volatile`.

The core/scratch split is the author's one declaration. Keys named in `x-state.volatile` ride in the scratch state; every other declared key stays in the state core; undeclared keys always land in scratch. The runtime owns the partition, the two stored messages (the state core first, the scratch state behind) and the merge; the author names the list and nothing else. Without an explicit list a heuristic applies: array-typed declared keys and the planning keys `plan`, `next_step`, `findings`, `open_questions` and `scratch` are volatile, and every other declared key is core.

The heuristic protects only array-typed keys and those five names; a plain scalar outside them gets no protection. A declared scalar that changes on most steps must therefore be named in `x-state.volatile`. Left off the list, it rides in the state core: every patch that writes it changes the state core, and the provider's cached prompt prefix breaks on every write instead of holding through the state core.

A knowledge bag is the open-object case: declare an object-typed key with no properties and `"additionalProperties": true`, and keep it off the `volatile` list. It then rides in the state core, so its bytes cache, and the object merge accrues its members key-wise — one new fact never re-sends the others. Route stable discovered facts (versions, build commands, ports, routes) into it; give `additionalProperties` a schema when the members should be typed. The same freezing works for anticipated discovery arrays: declare them as ordinary array keys and leave them off the volatile list, so once a list stops changing it caches in the core.

The bundled `skills/zstate/` is the worked example: a mode-entry skill whose schema keeps `goal`, `working_dir`, `constraints` and the `knowledge` bag in the state core and lists `plan`, `findings`, `open_questions` and `next_step` as volatile. Its `next_step` is a plain string overwritten every step, exactly the scalar case the rule above covers.
