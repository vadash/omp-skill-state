# SPEC: skill-state runtime

An omp plugin that runs a procedural skill against an explicit execution state instead of a growing transcript.
Target: `omp-skill-state`, shipped as an omp plugin. No file under the harness source tree is modified.

Status: agreed design, not yet implemented.

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

- `P` — the procedure spec: the skill body, verbatim, immutable for the run.
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

Persistence: after each accepted patch the runtime sends the state as a custom message of type `sh.omp.skill-state.state`, delivered as an aside so it lands at the next step boundary, before the next provider call. The message is stored in the transcript like any other, which is what lets the projection reuse it byte-for-byte (section 7). On `session_start` and `session_branch` the runtime rebuilds `t` from the latest such message on the branch, so `/resume` and rewinds keep it.

## 7. The projection

On every `context` event while engaged, the runtime returns a replacement message array containing, in order:

1. The runtime's operating rules, a custom message sent once at engage and passed through unchanged.
2. `P`, the skill body, a custom message sent once at engage and passed through unchanged.
3. `t`, the current state as a fenced JSON block, the latest stored state message passed through unchanged. Changes only when a patch is accepted.

Items 1 to 3 are stored transcript messages, not synthesised text. The projection returns the stored objects themselves. That is what makes them count as stable for caching (below).
4. `O_t`, the current step's observations, as the original observation messages with their roles preserved.
5. The last assistant `toolCall` and its `toolResult` pair, when the step's observation is itself a tool result. This keeps provider tool pairing intact so no repair is needed.
6. The current user turn, when it is a user prompt rather than a tool result.

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
- The cap is per step. Exactly one observation set is ever in the prompt, so the cap is a ceiling on the steady state, not a cumulative budget.

## 10. Compaction

While engaged, the runtime owns compaction. See ADR 0001.

- The `session_before_compact` handler is registered lazily, on the first engage, never at load. Registering it disables speculative compaction for the session, by the harness's own design, and `pi.on` has no counterpart, so it can never be removed.
- The handler returns the default behaviour (no result) when disengaged.
- When engaged it returns `{ compaction: { summary, shortSummary, firstKeptEntryId, tokensBefore, preserveData } }`:
  - `summary` — the rendered state plus a one-line note naming the procedure.
  - `firstKeptEntryId` — taken from the harness's own `preparation`, not computed.
  - `tokensBefore` — from `preparation`.
  - `preserveData` — the raw state, so the next compaction can carry it forward through `previousPreserveData`.
- No summarizer model call is made.

Because auto-compaction floors on the stored transcript, it still fires while engaged whenever the transcript crosses the threshold; the handler is what makes that firing cheap and lossless.

## 11. Disengaging

Four triggers, all leading to the same reset (clear `t`, clear engaged flag, stop projecting):

1. **New session.** `/new` starts one and fires `session_start`. This is the intended ending, and the runtime tells the user so (section 12).
2. **Context reset.** `/clear` keeps the session and drops messages in place, and emits nothing to extensions. The `input` event runs before command interpretation and does see the raw text, so the runtime disengages on `/clear` directly.
3. **Session change.** `session_before_switch`, `session_branch`, and `session_tree` all reset, so a rewind or fork cannot inherit a stale procedure.
4. **Idleness.** Three consecutive steps with no patch and an unchanged state. The model has stopped editing its state; the runtime stands down.

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
| Model stops updating the state | 3 idle steps | disengage, notify |
| State lost on resume | rebuild finds no entry | start from `{}`, notify |

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
| keep the head cacheable | return stored custom messages unchanged, so the provider anchors a breakpoint on `t` |
| own compaction | `session_before_compact`, lazily registered |
| detect `/clear` | `input` |
| reset on session change | `session_start`, `session_before_switch`, `session_branch`, `session_tree` |
| read the schema | `skill://<name>/state.schema.json`, plus `pi.pi.getActiveSkills()` |
| visibility | `ctx.ui.notify`, `registerMessageRenderer` |

## 17. Packaging

```
omp-skill-state/
  package.json          "omp": { "extensions": ["./index.ts"] }
  index.ts              the runtime
  skills/               optional bundled procedure skills, discovered from the plugin root
  CONTEXT.md            glossary
  docs/adr/             decisions
  SPEC.md               this file
```

Development install: `omp plugin link C:\projects\_llm\omp-skill-state`.
Dependency: `@oh-my-pi/pi-coding-agent` for types. If the published types lag the local checkout, switch to a `file:` dependency.

## 18. Testing

Unit, no harness needed:

- merge operator: set, null-delete, nested object merge, array replace, absent-key preservation.
- schema validation: each type, unknown keys under both `additionalProperties` values, non-object top level.
- projection assembly: exact message order and roles; each dropped block type; the pinned tail pair; the byte cap and its marker.

Against a real session:

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
