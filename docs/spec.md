# SPEC: skill-state runtime

An omp plugin that runs a procedural skill against an explicit execution state instead of a growing transcript.
Target: `omp-skill-state`, shipped as an omp plugin. No file under the harness source tree is modified.

Status: implemented and verified against a long real session; the acceptance run's figures are in `docs/verification.md`.

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
- `O_t` — the observation: the most recent tool pairs and the current user turn, under a byte cap.

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
   |                     +-- idle x5 --------------> disengage
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

```
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

```
{
  "x-state": {
    "observationBytes": 32768,
    "observationWindow": 3,
    "stateBytes": 16384,
    "idleSteps": 3,
    "retries": 3,
    "volatile": ["discovered_flags", "tested_hypotheses"]
  }
}
```

The schema is authored once per domain, not per task. A skill without `state.schema.json` is an ordinary skill and never engages.

`x-state.volatile` names the declared keys expected to change on most steps. They ride in the scratch state; every other declared key stays in the state core (sections 6 and 7). Non-string entries of the list are dropped. Without an explicit list the runtime applies a heuristic that protects the cache prefix: array-typed declared keys and the planning keys (`plan`, `next_step`, `findings`, `open_questions`, `scratch`) are volatile, and every other declared key is core.

## 6. Execution state

The state `t` is a JSON object. It starts as `{}` when a procedure engages.

Merge operator `⊕`, applied to each accepted patch:

- A key in `Δt` with a value other than `null` sets that key in `t`.
- A key in `Δt` with value `null` deletes that key from `t`, whatever its declared type: null is the typeless deletion operator, never a value.
- Keys absent from `Δt` are untouched.
- Merge is shallow and recursive only for objects: an object value merges key-wise, an array or scalar replaces.
- An array key may instead carry the append operator `{"$append": [items]}`, which appends the items to the current array instead of setting it whole; a missing key starts from an empty array. It exists so a growing list does not have to be re-emitted in full on every step.

This is the paper's dictionary merge with null-deletion semantics, and it is what makes the model's most common failure mode — omitting a key it meant to keep — harmless.

Validation, on every patch, before merge:

- Valid JSON object, or the patch is rejected.
- Every key present in the schema validates against its declared type — null excepted, per the deletion rule above — or the patch is rejected. An `$append` payload validates item-wise against the array's `items` schema.
- Unknown keys are accepted when `additionalProperties` is true.
- The keys `__proto__`, `constructor` and `prototype` are rejected outright, at every depth.
- A rejected patch changes nothing. The runtime does not partially apply.

Persistence: after each accepted patch the runtime sends the state as two custom messages, the state core (`sh.omp.skill-state.core`) first and the scratch state (`sh.omp.skill-state.scratch`) behind it, each carrying its partition in `details.state` and rendered as labelled plain JSON, delivered as asides so they land at the next step boundary, before the next provider call. The split is schema-driven, by `x-state.volatile` (section 5), and an empty partition is still stored as a `{}` message, so the head's shape never varies. Both messages are stored in the transcript like any other, which is what lets the projection reuse them byte-for-byte (section 7). On `session_start`, `session_switch`, `session_branch` and `session_tree` the runtime re-derives engagement from the latest invocation on the branch and the procedure-spec, state-core and scratch-state messages that follow it, taking the last message of each type and merging `{ ...core, ...scratch }`; either state message missing means inert, so `/resume`, rewinds and tree navigation keep it.

The run's final state is the live state at `agent_end`. The runtime polls `ctx.isIdle()` every 20 ms for up to 2 s and then sends both state messages, core then scratch, as next-turn messages (`deliverAs: "nextTurn"`): the harness then appends them to context and history at once, with no turn started. Sent any earlier, while the harness is still inside the loop, a next-turn message is only held in memory until the next prompt, and `/resume`, `/new` or quitting before that prompt loses it. A queued follow-up prompt keeps the session busy past the budget, in which case the messages are sent anyway and the harness holds them for that prompt. The waiting copy is dropped if a patch is accepted in the meantime (it is stale) or if the engagement ends in that window (a session switch or `/clear`: a message sent after it would land in the wrong context).

## 7. The projection

On every `context` event while engaged, the runtime returns a replacement message array containing, in order:

1. The runtime's operating rules, a custom message passed through unchanged.
2. `P`, the skill body as rendered for the invocation, a custom message passed through unchanged. The rendered skill prompt is used rather than the raw file so the user's invocation arguments stay in every step.
3. The state core, the declared keys the schema does not list as volatile, as labelled plain JSON — plain text by design, so the elide pass described in section 10 never targets it — the latest stored core message passed through unchanged. Changes only when a patch changes a core key.
4. The scratch state, the volatile-listed keys plus every undeclared key, the latest stored scratch message returned as a shallow clone of itself with one added detail field, `details.perCall`. The copy deliberately differs from its stored counterpart so the harness marks it per-call (below); the field lives outside the content, so the model sees the same bytes either way. Its rendered content changes whenever the scratch keys do.

Items 1 to 4 are the head: stored transcript messages, not synthesised text. The projection returns the stored objects themselves, the scratch excepted: there it returns the per-call clone above, so three of the four are stable for caching (below) and the scratch is deliberately not. The head is sent at engage and again after every compaction while engaged (`session_compact`), because the harness's cut can land after the original copies; the re-sent copies are byte-equal to the first except for the scratch clone, and the projection takes the last stored message of each type.

The operating rules also reach the model on the invocation batch itself. `before_agent_start` fires at the batch's dequeue, before the skill prompt's `message_end` can engage, so the handler cannot consult engagement state; it answers with the rules message when the prompt announces a procedure skill. The harness's user-invocation announcement line names the invoked skill, and the state-schema check filters every other prompt, so an ordinary prompt matches nothing. The harness appends the returned message to the batch and stores it with the transcript; the copy is byte-equal to the head's rules. The first step runs on ordinary context plus this message; from the second step on the projection takes the stored head's copy, and the first-step copy is dropped with the rest of the hidden history, so the cache never sees a difference.
5. `O_t`, the current step's observations, as the original observation messages with their roles preserved.
6. The observation window: the `observationWindow` most recent assistant `toolCall`/`toolResult` pairs, oldest first. The newest pair is mandatory: when the step's observation is itself a tool result, every result must answer a `toolCall` block of its assistant message, or the call is not projected. Older pairs follow the same pairing rule; the walk stops at the first unpairable older pair and keeps the pairs collected before it. This keeps provider tool pairing intact so no repair is needed.
7. The current user turn, when it is a user prompt rather than a tool result: every trailing user message of the batch. A trailing assistant message with no observation yet contributes nothing.

Everything else is dropped: all earlier assistant turns, all earlier tool results, all earlier user turns, and every injected live-state block — `goal-mode-context`, `plan-mode-context`, the eager-todo and mid-run-todo nudges, TTSR injections, and todo reminders.

The runtime never mutates the transcript. The dropped material remains on disk and in the branch; it is only absent from the prompt.

Caching. Prompt caching is positional: a breakpoint caches every byte before it, and a hit needs that whole prefix to match. The harness marks any message that is not byte-equal to its stored counterpart as per-call, and places one breakpoint on the newest message at or before the first per-call message. Items 1 to 3 are stored messages returned unchanged, so they are stable; the scratch clone is the first per-call message, and the breakpoint lands on the state core. Every step is then a cache hit on tools, system prompt, rules, `P` and the core, until a patch changes a core key and that step re-bills through the new core. Only the scratch state and the current observation are re-billed, and the scratch changes on most steps by design. The split is what lifts the breakpoint into the state at all: with the volatile keys riding in one full-state message, every step's patch would invalidate it and the breakpoint would fall back on `P`, caching only through the spec; split, the durable prefix reaches through the core. A synthesised `P` or `t`, or `P` appended to the system prompt through `before_agent_start`, would not be cached: the former is per-call, the latter lands after the volatile `<project-context>` block and outside the head breakpoint. The rules message returned from `before_agent_start` on the invocation batch needs no exception: the harness stores it with the batch, so the step-1 prompt copy is byte-equal to its stored counterpart, stable like the head, and step 1 is cold regardless; no cache behaviour relies on it.

## 8. Producing and validating the patch

The patch travels as a `state_update` extension tool (ADR 0002), registered through the harness's public `registerTool` once at factory load — the harness's own recommended pattern — so the definition sits in the model's tool declarations from turn 0 and its presence never depends on engage ordering. The operating rules in the head describe the channel from the first step on; no procedure spec has to carry the calling convention itself, and the rules reach the model from the very first step through the `before_agent_start` delivery (section 7). Registration is permanent for the session: no unregister exists, and after a disengage a late call meets a graceful `no active procedure` error result instead of a crash. A session that never engages a procedure still carries the definition in its tool list, where a stray call can only ever meet that same graceful error.

The definition carries `strict: true` and a single wrapper argument `patch`, an unconstrained JSON object holding the whole Δt. It also sets `loadMode: "essential"`: under `tools.xdev` a discoverable tool mounts as an `xd://` device, and the patch would then travel as freehand `write` content instead of protocol-level JSON — the malformed-input class this channel exists to exclude. The harness preserves `strict: true` on tool definitions and sends it to both the Anthropic and OpenAI families, with automatic fallback when a provider rejects it. The state schema is enforced at apply time rather than in the tool's parameter schema, so one schema source stays authoritative.

Approval is zero-cost by decision: the definition declares `{ tier: "read", policy: "allow" }`, so even always-ask approval modes never prompt for a state write. A per-tool user deny still wins, because the harness's approval resolver is consulted first.

Ordering, and why all-or-nothing survives the channel change:

1. `assistant_message` fires once per finalized assistant message, before the message reaches agent context, persistence, `message_end`, or tool dispatch. The handler scans the reply's tool-call blocks for the first `state_update` call and validates its `patch` against the state schema.
2. On failure it sets a pending-failure flag for this step and increments the retry counter.
3. `tool_call` fires next, at argument-prep time, for every call of the batch — the `state_update` call included. While the flag is set, the handler blocks every call and returns the validation error as the reason. Because the `state_update` call itself is blocked, no tool of the step has executed by the time the batch is refused.
4. When the patch is valid, the `state_update` execute runs with the rest of the batch: it re-validates defensively (an impossible failure would come back as the exact error in a failed tool result), merges the patch, commits the state, and asides land the new state's two messages, core then scratch, at the next step boundary, before the next provider call.
5. The model receives the block reason and re-emits. A blocked call does not execute and emits no result hook.

A step with no `state_update` call is legal and means an empty patch. A patch that leaves the state byte-identical commits nothing and sends nothing. Only an *invalid* patch blocks.

Retry and degrade:

- Up to `retries` (default 3) consecutive invalid patches: block and re-prompt.
- On the `retries`-th failure the runtime disengages, notifies the user, and leaves the transcript to speak for itself. From then on the session is ordinary.

The finish protocol is unchanged: a reply with no tool call still ends the run. Skills teach one final consolidating `state_update` in the step before it; because that patch arrives as a tool call, its asides are already stored during the run, and the run's final state is simply the live state at `agent_end`, settled as next-turn messages once the session is idle (section 6).

No JSON repair exists on this channel. Tool arguments are protocol-level JSON, so the freehand block's malformed-JSON failure class (the paper's measured ~12% on small models) does not exist here, and silent repair could produce different state than the model meant, where the block-retry-degrade path reports exact errors.

## 9. Caps

### Observation cap

`O_t` is capped at `observationBytes`, default 32768.

- The cap applies to the combined text of the whole observation window across its pairs, not to each result.
- Over the cap, the runtime truncates from the end of the largest result and inserts a marker naming what was cut and how to re-read it.
- Markers are never cut. When every result is cut to nothing, the observation is the markers alone, so the cap's floor is one marker per result.
- The cap is per step. Exactly one observation window is ever in the prompt, so the cap is a ceiling on the steady state, not a cumulative budget.

### State cap

The execution state is capped at `stateBytes` — the summed byte length of the two rendered state messages, the core's and the scratch's — default 0, which disables the cap; set per skill in `x-state`. The cap is soft: while the state measures over it, the next projected step's prompt carries a per-call developer nudge asking the model to consolidate the state with a `state_update` patch (drop superseded findings; `null` deletes a key). The nudge fires once per over-cap episode and re-arms when a commit lands the state back under the cap. The cap never blocks a step or a patch, and it never disengages or degrades the procedure: it is a signal, not a limit.

## 10. Compaction

While engaged, the runtime owns compaction. See ADR 0001.

- The `session_before_compact` handler is registered lazily, on the first engage, never at load. Registering it disables speculative compaction for the session, by the harness's own design, and `pi.on` has no counterpart, so it can never be removed.
- The handler returns the default behaviour (no result) when disengaged.
- When engaged it returns `{ compaction: { summary, shortSummary, firstKeptEntryId, tokensBefore, preserveData } }`:
  - `summary` — a one-line note naming the procedure plus the full state as plain JSON, both partitions in it.
  - `firstKeptEntryId` — the latest assistant message on the branch, i.e. the start of the current step, so the kept tail is exactly the step the next projection pins. Falls back to the harness's own `preparation` cut when the branch holds no assistant message yet.
  - `tokensBefore` — from `preparation`.
  - `preserveData` — `{ core, scratch }`, the two stored partitions, so the next compaction can carry them forward through `previousPreserveData`.
- No summarizer model call is made.

Because auto-compaction floors on the stored transcript, it still fires while engaged whenever the transcript crosses the threshold; the handler is what makes that firing cheap and lossless.

The cut is computed rather than taken from `preparation` because of what the harness does after a compaction. The harness proposes a turn-sized kept tail, and a procedure is one user turn, so its proposal keeps most of the run: entries the projection never sends but the harness still counts. When the kept tail is still over the harness's recovery band (0.8 × threshold) the harness treats the compaction as a dead end and "rescues" it with `shake("elide")`: it rewrites the kept entries in place, persisted to disk, replacing every tool result and every code or XML block of 400 or more tokens with a recovery placeholder. Custom messages are eligible, so an early integration run saw that pass rewrite the stored state messages and the current step's observation, and the projection then sent the model a placeholder as `t`. Cutting at the current step leaves nothing for the rescue to do. The state is rendered as plain labelled JSON for the same reason: the remaining shake paths (a manual `/shake`, the request-body-timeout and overflow retries) are not reachable through the extension API, and plain JSON under a label is never a shake region. The procedure spec `P` stays exposed to those paths if the skill body holds a code or XML block of 400 or more tokens.

## 11. Disengaging

Four triggers, all leading to the same reset (clear `t`, clear engaged flag, stop projecting):

1. **New session.** `/new` starts one, firing `session_before_switch` and then `session_switch` with reason `new`; `session_start` fires only on a cold load. This is the intended ending, and the runtime tells the user so (section 12). On every `session_start` and `session_switch` the runtime re-derives engagement from the branch rather than resetting blindly: an empty branch is inert; a branch holding a user skill invocation for a procedure skill followed by its procedure-spec message and its two state messages, the latest core and the latest scratch, re-engages with the merged state, and either state message missing is inert (the spec is read back from the branch so no file is re-read). That is what makes `/resume` restore `t` while `/new` starts clean.
2. **Context reset.** `/clear` keeps the session and drops messages in place, and emits nothing to extensions. The `input` event runs before command interpretation and does see the raw text, so the runtime disengages on `/clear` directly.
3. **Session change.** A switch, a rewind or a fork all land in a different session id, so `session_before_switch` and `session_before_branch` end the outgoing engagement with the usual disengage notice. `session_switch`, `session_branch` and `session_tree` then re-derive engagement from the branch now loaded: a rewind that lands after the invocation re-engages with that branch's state, one that lands before it stays inert, and a fork re-derives like any other branch.
4. **Idleness.** `idleSteps` consecutive steps with no patch or with a patch that leaves the state unchanged. At `idleSteps` − 1 consecutive idle steps — never at zero: a skill that sets `idleSteps` to 1 disengages on its first idle step unwarned — the next step's prompt carries a per-call developer nudge naming the count and the imminent disengage, so the model can record a meaningful fact before the cutoff; the nudge is never stored and never re-sent from history. The model has stopped editing its state; the runtime stands down. A step whose provider call carried no stored head still does not count: the first step carries the rules through the `before_agent_start` delivery (section 7) but runs before the engage asides land, and the step after a compaction can run before the re-sent head lands, so the rules are missing from its prompt in that case — no head means no count and no nudge. An early integration run disengaged on a legitimate preamble of reads before the first fact; the raised default and the nudge above are the answer to that case.

The remaining exit is **degrade**, from section 8, which is a failure path rather than a normal ending.

## 12. Visibility

- On engage: `ctx.ui.notify` naming the procedure, and — because the projection hides history — a second user-facing line that tells the user to finish with `/new`. Both are UI-only and never enter model context.
- On disengage and on degrade: a notify stating which happened and why.
- The runtime registers one message renderer per state message type, `sh.omp.skill-state.core` and `sh.omp.skill-state.scratch`, so both partitions are readable in the transcript after the fact: collapsed to a label naming the partition with a key count, expanded to pretty JSON under the partition's name.
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
| Head message missing on rebuild | invocation without a following procedure-spec message or either state message | stay inert: there is no head to project |

Degrade is terminal for the session. The user gets ordinary history-based execution back, which is always correct, only more expensive.

## 15. Parameters and defaults

| Parameter | Default | Source |
| --- | --- | --- |
| `observationBytes` | 32768 | schema `x-state`, else runtime default |
| `idleSteps` | 5 | schema `x-state` |
| `retries` | 3 | schema `x-state` |
| `observationWindow` | 1 | schema `x-state`, else runtime default |
| `stateBytes` | 0 (disabled) | schema `x-state`, else runtime default |
| `volatile` | heuristic: array-typed and planning keys | schema `x-state.volatile`, else runtime heuristic |
| dropped blocks | all live-state blocks | fixed in v1 |

## 16. Harness surfaces used

Every mechanism above is public extension API. Nothing else is touched.

| Need | Surface |
| --- | --- |
| per-step rewrite | `context` event; receives `AgentMessage[]` before `convertToLlm`, so `customType` is still visible, and its replacement never rewrites stored history |
| nudge at the policy thresholds | the `context` handler appending `pendingNudges(procedure)` after the projected messages: the consolidation ask latched once per over-cap episode (`capNudged`, re-armed when a commit lands back under `stateBytes`) and the idle warning one step before the idle disengage, consolidation first, idle last; the nudges ride the event's replacement, are never stored and never re-sent from history (sections 9 and 11) |
| validate before tools run | `assistant_message`, awaited before tool dispatch |
| block a batch | `tool_call`, may block with a reason |
| offer the state-write channel | `registerTool` with the strict, zero-approval `state_update` definition, registered once at factory load (section 8) |
| deliver the rules on the first step | `before_agent_start` returning the rules message on the invocation batch; the harness's announcement line names the invoked skill (section 7) |
| persist the head: the state core, the scratch state, `P`, rules | `sendMessage` with `deliverAs: "aside"`, plus `ctx.sessionManager.getBranch()` to rebuild |
| persist the run's final `t` | `agent_end`, then `sendMessage` with `deliverAs: "nextTurn"` once `ctx.isIdle()` (section 6) |
| re-send the head after a compaction | `session_compact`, then `sendMessage` with `deliverAs: "aside"` during a run or `"nextTurn"` when `ctx.isIdle()` (section 7) |
| keep the head cacheable | return the stored rules, spec and core unchanged and the scratch as its per-call copy, so the provider anchors the breakpoint on the state core |
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
  state.ts              the execution state module: schema and params loading, patch validation, merge and apply, the core/scratch split (volatileKeys, splitState)
  state.test.ts         execution state unit tests (bun test)
  messages.ts           the message vocabulary: the head message types, the state renderer and the core and scratch state builders
  messages.test.ts      message vocabulary unit tests (bun test)
  fake-session.ts       the fake omp session for the adapter tests (branch, delivery timing, sends)
  skill-fixtures.ts     the shared test fixture writing skill directories for the adapter and state tests (makeSkill)
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

- merge operator: set, null-delete (any declared type), nested object merge, array replace, `$append` onto existing, missing and non-array keys, absent-key preservation.
- the state split: explicit `x-state.volatile` parsing (non-string entries dropped), the unannotated-schema heuristic (array-typed and planning keys volatile), and the disjoint core/scratch partition.
- schema validation: each type, unknown keys under both `additionalProperties` values, non-object top level.
- projection assembly: exact message order and roles; each dropped block type; the observation window; the byte cap and its marker.
- branch reads: the re-derive scan (latest invocation wins, an incomplete head is inert) and the compaction cut.
- step policy: each reply outcome (none, store, block, ended by degrade or idle), the counters and their resets, the head and the compaction result.
- first-step rules delivery on engage, and its absence for non-procedure prompts, agent-attributed invocations, subagents and mid-procedure batches.

`index.test.ts` drives the factory through a fake omp session (`fake-session.ts`): one factory with N sessions keyed by id, each owning its branch, sends, notices and idle flag. The fake auto-dispatches the harness event order inside one verb, assembles the context of each provider call from its branch, captures `registerTool` definitions, and models delivery timing: messages sent while busy flush at the end of the current step (so the stored head after engage lands at the first step boundary, while the first step's rules come from the `before_agent_start` delivery on the batch itself), messages sent while idle are appended at once, a reply with no tool call ends the run, and a call whose name has a captured definition runs that definition inside the step, recording its own result. The delivery model is the fake interface contract; `docs/verification.md` remains the real-session ground truth.

Against a real session (run G and the nudge probe in `docs/verification.md`; the invalid-patch refusal occurred in run G, the degrade path did not occur and rests on the unit tests, and the `/new`, `/clear` and rewind outcomes are in the doc's git history):

- engage on a user `/skill:` for a schema-bearing skill; stay inert for a skill without one; stay inert for a model-initiated `read skill://…`.
- invalid patch blocks the batch and the retry recovers.
- three failures degrade and notify.
- `t` survives `/resume` and a rewind.
- compaction while engaged produces a state summary and makes no summarizer call, and speculative compaction is off from that point.
- `/new` and `/clear` both disengage.
- prompt size is flat across a long run: assert the reported input tokens per step stay inside a band.

## 19. Out of scope

- Multi-agent procedures with concurrent state writes and conflict resolution.
- Automatic schema discovery for skills that do not declare one.
- Any change under the harness source tree.
- Multiple concurrent procedures per session; retrieval or summarization of dropped history.
- Whole-array append beyond the `$append` operator (no positional splices, no per-index edits).
- JSON repair in any form; `setActiveTools` registration gymnastics.
- Hard enforcement of the state cap (the nudge is the only sanction, by decision).

## 20. Design record: the V2 change

The v1 runtime executed a narrow class of procedures well: one tool result of memory per step, a state of a handful of keys. Four leaks out of that shape drove the V2 change: the one-pair observation forced re-reads across consecutive steps; a tight idle threshold disengaged on a legitimate quiet preamble; the fenced patch channel arrived one step late — no rules on the first prompt — so skills had to re-teach the patch format; and nothing checked state growth. On the cost side the cache ceiling sat too low: the state changes nearly every step, so everything after the procedure spec — roughly a third of a procedure step — re-billed, and on Anthropic-shaped providers even the rules and the spec re-billed for lack of a per-call mark.

Four generalities and one channel change answered that. Decisions are recorded in ADR 0002 and ADR 0003; the behavior lives in sections 5, 7, 8, 9 and 11:

- Observation window: pin the last K tool pairs, not one, under one shared byte cap.
- Idle: default threshold 5, and a turn-scoped warning nudge one step before the disengage.
- First-step rules: the operating rules delivered on the invocation batch, so no skill teaches the patch format.
- State cap: a soft `stateBytes` cap whose only sanction is a consolidation nudge.
- Patch channel: the strict, zero-approval `state_update` tool; the fenced block and its parser deleted outright, not kept as a fallback. Rejected: dual channels — a precedence rule in every doc and test surface, for a failure class the tool cannot produce — and JSON repair — silent corruption of the only record of the past, where block-and-retry reports exact errors.
- Head split: the state message splits into a byte-stable core and a per-call scratch, so the durable cache breakpoint anchors on the core. Rejected: a single state message, which holds the ceiling at through-the-spec, and per-call marks on the whole head, which would cache nothing.

Measured in run G (`docs/verification.md`): `cacheRead` pinned at 10496 — system prompt, tools, rules, spec, state core — across the patched steps while only the scratch, the observation window and the user turn re-billed. The baseline to beat was run F: median prompt 11,348 tokens, uncached median 788, cache read positive on 49 of 51 steps, a through-the-spec ceiling.
