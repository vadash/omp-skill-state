# SPEC: skill-state runtime

An omp plugin that runs a procedural skill against an explicit execution state instead of a growing transcript.
Target: `omp-skill-state`, shipped as an omp plugin. No file under the harness source tree is modified.

Status: implemented and verified against a long real session; the run, its figures and the deviations it forced are in `docs/verification.md`.

---

## 1. Purpose

A conversation-based runtime sends the model the skill text plus every past reasoning trace, action and observation. Prompt size therefore grows with the number of steps, and obsolete facts stay in context after they stop being true.

This runtime sends the model three things and nothing else: the immutable procedure spec, the current execution state, and the latest observation. Reasoning is discarded after each step. The stored transcript is kept in full; only the prompt is bounded.

Non-goals:

- Replacing compaction, memory backends, or the todo system.
- Applying to every session. A procedure runs only when the user invokes a skill that declares a state schema.
- Summarising or retrieving history. The state is a sufficient statistic, not a digest.

## 2. The model

At step `t` the model receives exactly:

```
A_t = (P, t, O_t)
```

- `P` — the procedure spec: the skill body as the harness renders it for the user invocation (body, skill directory, user arguments), immutable for the run.
- `t` — the execution state: a JSON object satisfying the state schema.
- `O_t` — the observation: the tool results and user turn of the current step, under a byte cap.

The model replies with a state patch `Δt`, tool calls, or both. The runtime validates `Δt`, merges it into `t`, and lets the tool calls run. Nothing else from the past is ever sent.

Consequence: the prompt is `O(1)` in the number of steps; cumulative prompt cost is `O(T)`.

## 3. Lifecycle

```
                 user /skill:<name>
                         |
                    arm  |  skill declares a state schema? no -> ordinary session
                         v
   +----------------> engage --> step loop (projection each provider call)
   |                     |
   |                     +-- invalid patch x3 ----> degrade (self-disable, notify)
   |                     |
   |                     +-- idle x3 --------------> disengage
   |                     |
   |                     +-- /new, /clear, session change -> disengage
   v
 ordinary session
```

Four states: **inert** (loaded, doing nothing), **armed** (a procedure skill was invoked), **engaged** (projection active), **degraded** (self-disabled for the session).

Arm and engage happen together in practice. The split matters only because arming is observable and cheap, and engagement owns the compaction registration.

## 4. Activation

The runtime engages when all of these hold:

1. A user-invoked skill prompt is present in the conversation. The test is the harness's own: a message with `customType === "skill-prompt"` and `attribution === "user"`. A model-initiated `read skill://…` never counts.
2. That skill declares a state schema.
3. The message is in the main agent. Subagent sessions stay inert.

Detection is direct: `/skill:<name>` produces a message whose `details` carry `name` and `path`. The runtime reads `state.schema.json` from the skill's directory. It resolves the path as a sibling of the skill file, and reads it through `skill://<name>/state.schema.json`, which the harness already resolves inside the skill's base directory.

The runtime also calls `pi.pi.getActiveSkills()` to map a name to its `filePath` and `baseDir` when `details` are absent (older sessions, RPC paths).

Engagement is scoped by `ctx.sessionManager.getSessionId()`. Extension module state is shared across sessions, so a bare module-level flag would leak between them.

## 5. Procedure package

A procedure skill is a normal skill with one extra file:

```
skills/<name>/
  SKILL.md            required; the procedure spec P
  state.schema.json   required; declares the execution state
```

`state.schema.json` is a JSON Schema subset:

```json
{
  "type": "object",
  "properties": {
    "working_dir": { "type": "string" },
    "discovered_flags": { "type": "array", "items": { "type": "string" } },
    "tested_hypotheses": { "type": "array", "items": { "type": "string" } }
  },
  "additionalProperties": true
}
```

Rules:

- The top level must be an object.
- Types used: `string`, `number`, `boolean`, `array`, `object`, `null`.
- `additionalProperties` defaults to `true`, so a procedure can carry keys the schema does not name.
- Optional `x-state` block for runtime parameters:

```json
{
  "x-state": {
    "observationBytes": 32768,
    "idleSteps": 3,
    "retries": 3
  }
}
```

The schema is authored once per domain, not per task. A skill without `state.schema.json` is an ordinary skill and never engages.

## 6. Execution state

The state `t` is a JSON object. It starts as `{}` when a procedure engages.

Merge operator `⊕`, applied to each accepted patch:

- A key in `Δt` with a value other than `null` sets that key in `t`.
- A key in `Δt` with value `null` deletes that key from `t`.
- Keys absent from `Δt` are untouched.
- Merge is shallow and recursive only for objects: an object value merges key-wise, an array or scalar replaces.

This is the paper's dictionary merge with null-deletion semantics, and it is what makes the model's most common failure mode — omitting a key it meant to keep — harmless.

Validation, on every patch, before merge:

- Valid JSON object, or the patch is rejected.
- Every key present in the schema validates against its declared type, or the patch is rejected.
- Unknown keys are accepted when `additionalProperties` is true.
- A rejected patch changes nothing. The runtime does not partially apply.

Persistence: after each accepted patch the runtime sends the state as a custom message of type `sh.omp.skill-state.state`, delivered as an aside so it lands at the next step boundary, before the next provider call. The message is stored in the transcript like any other, which is what lets the projection reuse it byte-for-byte (section 7). On `session_start`, `session_switch`, `session_branch` and `session_tree` the runtime re-derives engagement from the latest invocation on the branch and the procedure-spec and state messages that follow it, so `/resume`, rewinds and tree navigation keep it.

The final step is the exception. Its reply carries no tool call, so the run is ending and an aside that outlives a run wakes a turn of its own. Its state is instead sent as a next-turn message (`deliverAs: "nextTurn"`) once the session is idle after `agent_end`: the harness then appends it to context and history at once, with no turn started. Sent any earlier, while the harness is still inside the loop, a next-turn message is only held in memory until the next prompt, and `/resume`, `/new` or quitting before that prompt loses it. The runtime polls `ctx.isIdle()` every 20 ms for up to 2 s; a queued follow-up prompt keeps the session busy past that, in which case the message is sent anyway and the harness holds it for that prompt. The waiting state is dropped if a patch is accepted in the meantime (it is stale) or if the engagement ends in that window (a session switch or `/clear`: a message sent after it would land in the wrong context).

## 7. The projection

On every `context` event while engaged, the runtime returns a replacement message array containing, in order:

1. The runtime's operating rules, a custom message passed through unchanged.
2. `P`, the skill body as rendered for the invocation, a custom message passed through unchanged. The rendered skill prompt is used rather than the raw file so the user's invocation arguments stay in every step.
3. `t`, the current state as labelled plain JSON (no fence, see section 10), the latest stored state message passed through unchanged. Changes only when a patch is accepted.

Items 1 to 3 are the head: stored transcript messages, not synthesised text. The projection returns the stored objects themselves. That is what makes them count as stable for caching (below). The head is sent at engage and again after every compaction while engaged (`session_compact`), because the harness's cut can land after the original copies; each copy is byte-equal to the first, and the projection takes the last stored message of each type.
4. `O_t`, the current step's observations, as the original observation messages with their roles preserved.
5. The last assistant `toolCall` and its `toolResult` pair, when the step's observation is itself a tool result. Every result must answer a `toolCall` block of that assistant message; otherwise the call is not projected. This keeps provider tool pairing intact so no repair is needed.
6. The current user turn, when it is a user prompt rather than a tool result: every trailing user message of the batch. A trailing assistant message with no observation yet contributes nothing.

Everything else is dropped: all earlier assistant turns, all earlier tool results, all earlier user turns, and every injected live-state block — `goal-mode-context`, `plan-mode-context`, the eager-todo and mid-run-todo nudges, TTSR injections, and todo reminders.

The runtime never mutates the transcript. The dropped material remains on disk and in the branch; it is only absent from the prompt.

Caching. Prompt caching is positional: a breakpoint caches every byte before it, and a hit needs that whole prefix to match. The harness marks any message that is not byte-equal to its stored counterpart as per-call, and places one breakpoint on the newest message at or before the first per-call message. Because items 1 to 3 are stored messages returned unchanged, they are stable; the first per-call message is the observation; and the breakpoint lands on `t`. Every step is then a cache hit on tools, system prompt, rules, `P` and `t`, until the next accepted patch moves `t`. Only the current observation is re-billed, and it changes every step regardless. A synthesised `P` or `t`, or `P` appended to the system prompt through `before_agent_start`, would not be cached: the former is per-call, the latter lands after the volatile `<project-context>` block and outside the head breakpoint.

## 8. Producing and validating the patch

The model emits the patch as a fenced `json` block in its assistant text, labelled with a fixed marker, alongside its tool calls.

Ordering, and why it works:

1. `assistant_message` fires once per finalized assistant message, before the message reaches agent context, persistence, `message_end`, or tool dispatch.
2. The handler parses the fenced block. On success it validates and merges, then clears the step's pending-failure flag.
3. On failure it sets a pending-failure flag for this step and increments the retry counter.
4. `tool_call` fires next, at argument-prep time. While the flag is set, the handler blocks every call in the batch and returns the validation error as the reason.
5. The model receives the block reason and re-emits. A blocked call does not execute and emits no result hook.

A step with no patch block is legal and means an empty patch. Only an *invalid* patch blocks.

Retry and degrade:

- Up to `retries` (default 3) consecutive invalid patches: block and re-prompt.
- On the `retries`-th failure the runtime disengages, notifies the user, and leaves the transcript to speak for itself. From then on the session is ordinary.

Strict schemas: the harness preserves `strict: true` on tool definitions and sends it to both Anthropic and OpenAI families, with automatic fallback when a provider rejects it. A `state_update` tool with a strict schema is the stronger option for small models, which the paper measures failing on JSON syntax 12% of the time. It is not in v1; the patch-block path ships first, and the tool is added only if a measured failure rate justifies it.

## 9. Observation cap

`O_t` is capped at `observationBytes`, default 32768.

- The cap applies to the step's combined observation text, not to each result.
- Over the cap, the runtime truncates from the end of the largest result and inserts a marker naming what was cut and how to re-read it.
- Markers are never cut. When every result is cut to nothing, the observation is the markers alone, so the cap's floor is one marker per result.
- The cap is per step. Exactly one observation set is ever in the prompt, so the cap is a ceiling on the steady state, not a cumulative budget.

## 10. Compaction

While engaged, the runtime owns compaction. See ADR 0001.

- The `session_before_compact` handler is registered lazily, on the first engage, never at load. Registering it disables speculative compaction for the session, by the harness's own design, and `pi.on` has no counterpart, so it can never be removed.
- The handler returns the default behaviour (no result) when disengaged.
- When engaged it returns `{ compaction: { summary, shortSummary, firstKeptEntryId, tokensBefore, preserveData } }`:
  - `summary` — a one-line note naming the procedure plus the state as plain JSON.
  - `firstKeptEntryId` — the latest assistant message on the branch, i.e. the start of the current step, so the kept tail is exactly the step the next projection pins. Falls back to the harness's own `preparation` cut when the branch holds no assistant message yet.
  - `tokensBefore` — from `preparation`.
  - `preserveData` — the raw state, so the next compaction can carry it forward through `previousPreserveData`.
- No summarizer model call is made.

Because auto-compaction floors on the stored transcript, it still fires while engaged whenever the transcript crosses the threshold; the handler is what makes that firing cheap and lossless.

The cut is computed rather than taken from `preparation` because of what the harness does after a compaction. The harness proposes a turn-sized kept tail, and a procedure is one user turn, so its proposal keeps most of the run: entries the projection never sends but the harness still counts. When the kept tail is still over the harness's recovery band (0.8 × threshold) the harness treats the compaction as a dead end and "rescues" it with `shake("elide")`: it rewrites the kept entries in place, persisted to disk, replacing every tool result and every fenced or XML block of 400 or more tokens with a recovery placeholder. Custom messages are eligible, so that pass rewrote the stored state messages and the current step's observation in the integration run (`docs/verification.md`), and the projection then sent the model a placeholder as `t`. Cutting at the current step leaves nothing for the rescue to do. The state is rendered without a fence for the same reason: the remaining shake paths (a manual `/shake`, the request-body-timeout and overflow retries) are not reachable through the extension API, and plain JSON under a label is never a shake region. The procedure spec `P` stays exposed to those paths if the skill body holds a fenced or XML block of 400 or more tokens.

## 11. Disengaging

Four triggers, all leading to the same reset (clear `t`, clear engaged flag, stop projecting):

1. **New session.** `/new` starts one, firing `session_before_switch` and then `session_switch` with reason `new`; `session_start` fires only on a cold load. This is the intended ending, and the runtime tells the user so (section 12). On every `session_start` and `session_switch` the runtime re-derives engagement from the branch rather than resetting blindly: an empty branch is inert; a branch holding a user skill invocation for a procedure skill followed by its procedure-spec message and a state message re-engages with that state (the spec is read back from the branch so no file is re-read). That is what makes `/resume` restore `t` while `/new` starts clean.
2. **Context reset.** `/clear` keeps the session and drops messages in place, and emits nothing to extensions. The `input` event runs before command interpretation and does see the raw text, so the runtime disengages on `/clear` directly.
3. **Session change.** A switch, a rewind or a fork all land in a different session id, so `session_before_switch` and `session_before_branch` end the outgoing engagement with the usual disengage notice. `session_switch`, `session_branch` and `session_tree` then re-derive engagement from the branch now loaded: a rewind that lands after the invocation re-engages with that branch's state, one that lands before it stays inert, and a fork re-derives like any other branch.
4. **Idleness.** `idleSteps` consecutive steps with no patch or with a patch that leaves the state unchanged. The model has stopped editing its state; the runtime stands down. A step whose provider call carried no head does not count: the first step runs before the engage asides land, and the step after a compaction can run before the re-sent head lands, so the model has not seen the rules in it. The integration run (`docs/verification.md`, finding 7) showed the rule firing on a legitimate preamble of reads before the first fact; it is kept as specified.

The remaining exit is **degrade**, from section 8, which is a failure path rather than a normal ending.

## 12. Visibility

- On engage: `ctx.ui.notify` naming the procedure, and — because the projection hides history — a second user-facing line that tells the user to finish with `/new`. Both are UI-only and never enter model context.
- On disengage and on degrade: a notify stating which happened and why.
- The runtime registers a message renderer for the `sh.omp.skill-state.state` entry, so the state is readable in the transcript after the fact.
- Optional status-line indicator while engaged, naming the procedure.

## 13. Subagents

Extension factories are rebound into every subagent session, so the handler runs there too. The runtime checks the agent kind and stays inert unless it is the main agent. A procedure started in the main session does not follow a `task` subagent, and a subagent cannot start one.

## 14. Failure modes

| Failure | Detection | Response |
| --- | --- | --- |
| Invalid patch | validation | block the batch, re-prompt, up to `retries` |
| Repeated invalid patches | retry counter | degrade, notify, ordinary session |
| Missing or malformed schema | load | do not engage; notify |
| Oversized observation | byte cap | truncate from the end of the largest result, insert a marker |
| Provider rejects the prompt shape | provider error surfaced to the session | the harness's own retry and compaction paths apply; the runtime does not intercept them |
| Model stops updating the state | `idleSteps` idle steps | disengage, notify |
| Head message missing on rebuild | invocation without a following procedure-spec message or state message | stay inert: there is no head to project |

Degrade is terminal for the session. The user gets ordinary history-based execution back, which is always correct, only more expensive.

## 15. Parameters and defaults

| Parameter | Default | Source |
| --- | --- | --- |
| `observationBytes` | 32768 | schema `x-state`, else runtime default |
| `idleSteps` | 3 | schema `x-state` |
| `retries` | 3 | schema `x-state` |
| pinned tail | last tool pair | fixed in v1 |
| dropped blocks | all live-state blocks | fixed in v1 |

## 16. Harness surfaces used

Every mechanism above is public extension API. Nothing else is touched.

| Need | Surface |
| --- | --- |
| per-step rewrite | `context` event; receives `AgentMessage[]` before `convertToLlm`, so `customType` is still visible, and its replacement never rewrites stored history |
| validate before tools run | `assistant_message`, awaited before tool dispatch |
| block a batch | `tool_call`, may block with a reason |
| pin `P` and the rules | `before_agent_start` returning a `systemPrompt`, plus `developer` messages |
| persist `t`, `P`, rules | `sendMessage` with `deliverAs: "aside"`, plus `ctx.sessionManager.getBranch()` to rebuild |
| persist the final step's `t` | `agent_end`, then `sendMessage` with `deliverAs: "nextTurn"` once `ctx.isIdle()` (section 6) |
| re-send the head after a compaction | `session_compact`, then `sendMessage` with `deliverAs: "aside"` during a run or `"nextTurn"` when `ctx.isIdle()` (section 7) |
| keep the head cacheable | return stored custom messages unchanged, so the provider anchors a breakpoint on `t` |
| own compaction | `session_before_compact`, lazily registered |
| detect `/clear` | `input` |
| detect a user skill invocation | `message_end`; the harness's own skill-prompt message, checked for `attribution === "user"` |
| detect a session change | `session_before_switch`, `session_before_branch`; `session_start`, `session_switch`, `session_branch`, `session_tree` re-derive engagement from the branch (section 11) |
| read the schema | `skill://<name>/state.schema.json`, plus `pi.pi.getActiveSkills()` |
| visibility | `ctx.ui.notify`, `registerMessageRenderer` |

## 17. Packaging

```
omp-skill-state/
  package.json          "omp": { "extensions": ["./index.ts"] }
  index.ts              the harness adapter: event registrations, sends, blocks, notices
  index.test.ts         unit tests (bun test)
  projection.ts         the projection (pure message assembly)
  projection.test.ts    projection unit tests (bun test)
  branch.ts             pure reads over the stored branch (re-derive scan, compaction cut)
  branch.test.ts        branch read unit tests (bun test)
  procedure.ts          the procedure record and the step policy (patch outcomes, head, compaction)
  procedure.test.ts     step policy unit tests (bun test)
  messages.ts           the message vocabulary: the head message types, the state renderer and the state message builder
  messages.test.ts      message vocabulary unit tests (bun test)
  tsconfig.json         typecheck config (tsc --noEmit)
  skills/               optional bundled procedure skills, discovered from the plugin root
  CONTEXT.md            glossary
  docs/adr/             decisions
  docs/spec.md          this file
```

Development install: `omp plugin link C:\projects\_llm\omp-skill-state`.
Dependency: `@oh-my-pi/pi-coding-agent` for types, pinned to the installed omp version. The published package ships `dist/types`, which keeps typechecking independent of the harness source. The intended fallback for lagging published types, a `file:` dependency on the local checkout, does not work as written: the checkout is a workspace member whose dependencies use `catalog:` specifiers, which bun resolves only inside the monorepo, and whose `types` entry points at `src/index.ts`. README.md, "Extension types", records the verified detail and the order of workarounds.

## 18. Testing

Unit, no harness needed:

- merge operator: set, null-delete, nested object merge, array replace, absent-key preservation.
- schema validation: each type, unknown keys under both `additionalProperties` values, non-object top level.
- projection assembly: exact message order and roles; each dropped block type; the pinned tail pair; the byte cap and its marker.
- branch reads: the re-derive scan (latest invocation wins, an incomplete head is inert) and the compaction cut.
- step policy: each reply outcome (none, store as aside or final, block, ended by degrade or idle), the counters and their resets, the head and the compaction result.

Against a real session (`docs/verification.md` records the outcome of each item; the invalid-patch and degrade items did not occur in the run and rest on the unit tests):

- engage on a user `/skill:` for a schema-bearing skill; stay inert for a skill without one; stay inert for a model-initiated `read skill://…`.
- invalid patch blocks the batch and the retry recovers.
- three failures degrade and notify.
- `t` survives `/resume` and a rewind.
- compaction while engaged produces a state summary and makes no summarizer call, and speculative compaction is off from that point.
- `/new` and `/clear` both disengage.
- prompt size is flat across a long run: assert the reported input tokens per step stay inside a band.

## 19. Out of scope for v1

- Multi-agent procedures with concurrent state writes and conflict resolution.
- Grammar-constrained patch output via a strict tool.
- Automatic schema discovery for skills that do not declare one.
- Any change under the harness source tree.
