# omp-skill-state

An [omp](https://omp.sh) plugin that runs a procedural skill against an explicit execution state instead of a growing transcript. The design is in `docs/spec.md`; the vocabulary is in `CONTEXT.md`.

Status: implemented and verified against a long real session (`docs/verification.md`). A procedure skill engages and disengages; the model's fenced `state` patches are validated, merged and persisted as state messages, and invalid patches block the step and degrade after `retries` failures. While engaged, every provider call sees only the operating rules, the procedure spec, the latest state, the current step's observation (byte-capped) and the current user turn; the stored transcript stays complete. Compaction while engaged is owned by the runtime: the summary is the state, the cut is the current step, and no summarizer call is made.

## Layout

| Path | Role |
| --- | --- |
| `package.json` | Plugin manifest: `"omp": { "extensions": ["./index.ts"] }` |
| `index.ts` | The extension: a thin harness adapter over the modules below. omp imports the TypeScript directly; there is no build step. |
| `branch.ts` | Pure reads over the stored branch: the re-derive scan and the compaction cut. |
| `procedure.ts` | The procedure record and the step policy: patch outcomes, idle and retry counters, head and compaction construction. |
| `messages.ts` | The custom message vocabulary: the head message types, the state renderer and the state message builder. |
| `fake-session.ts` | The fake omp session the adapter tests drive: branch, delivery timing, sends and notices. |
| `index.test.ts`, `*.test.ts` | Unit tests for the factory contract, the step policy, the branch reads, the state merge, the patch parser and the projection |
| `skills/recon/` | Bundled mode-entry procedure skill (`SKILL.md` + `state.schema.json`): it carries no task of its own; the task is the text given with the invocation |
| `docs/spec.md`, `docs/adr/`, `CONTEXT.md` | Design, decisions, glossary |
| `docs/verification.md`, `verification/` | The long-session integration run: findings, and the session analyzer plus the config that drives it |

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

`link` creates a junction at `~/.omp/plugins/node_modules/omp-skill-state` and an enabled entry in `~/.omp/plugins/omp-plugins.lock.json`. Changes to `index.ts` take effect at the next session start. Remove the link with `omp plugin uninstall omp-skill-state`.

Invoke a procedure skill (a skill with a `state.schema.json`) in the main agent and it engages. The bundled `recon` skill takes its task from the invocation text, e.g. `/skill:recon read skill://implement and work on issue 67`:

```
skill-state: procedure "recon" engaged
skill-state: history is hidden from the model while engaged; finish with /new
```

The runtime disengages on `/new`, `/clear`, a session switch or fork, a branch, or tree navigation, with one notice naming the trigger:

```
skill-state: procedure "recon" disengaged (/new)
```

Skills without a state schema, model-initiated skill reads, and subagent sessions stay silent. Engagement is keyed by session id, so two sessions in one process never see each other's procedures.

## Extension types

`index.ts` imports `ExtensionAPI` and friends as types only, plus two value imports: `Text` from `@oh-my-pi/pi-coding-agent` (the state message renderer) and `InternalUrlRouter` from `@oh-my-pi/pi-coding-agent/internal-urls` (in `state.ts`, to resolve `skill://` paths). At load time omp rewrites every `@oh-my-pi/pi-coding-agent/*` import from a plugin onto its own bundled copy (the plugin compat layer in the harness, `legacy-pi-compat`), so there is still no separate runtime dependency to install.

The types come from the published `@oh-my-pi/pi-coding-agent` package, pinned to the version of the installed omp (`omp --version`). The published package ships `dist/types/*.d.ts`, which keeps `tsc` fast and independent of the harness source.

### When the published types lag the local checkout

The spec names a `file:` dependency on the harness checkout at `C:\projects\_llm\oh-my-pi\packages\coding-agent` as the fallback:

```json
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
