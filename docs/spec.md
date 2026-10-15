# SPEC: skill-state runtime

An omp plugin that runs a procedural skill against an explicit execution state instead of a growing transcript.
Target: `omp-skill-state`, shipped as an omp plugin. No file under the harness source tree is modified.

Status: implemented, the universal redesign included. ADR 0010-0012 record its decisions and section 20 is its design record. The figures in `docs/verification.md` are the earlier runtime's (runs G and H predate the redesign); the post-redesign acceptance runs are pending and are recorded there.

---

## 1. Purpose

A conversation-based runtime sends the model the skill text plus every past reasoning trace, action and observation. Prompt size therefore grows with the number of steps, and obsolete facts stay in context after they stop being true.

This runtime sends the model the immutable procedure spec, the current execution state and the recent conversation under a prompt budget — a percent of the model's context window — and nothing else. Reasoning leaves the prompt as the window moves past it, and the stored transcript is kept in full; only the prompt is bounded.

Non-goals:

- Replacing compaction, memory backends, or the todo system.
- Applying to every session. A procedure runs only when the user invokes a skill that declares a state schema.
- Summarising history. The state is explicit and the recent conversation stays raw; nothing is digested, and dropped history is read back verbatim rather than compressed.

## 2. The model

At step `t` the model receives:

```
A_t = (P, t, T_t)
```

- `P` — the procedure spec: the skill body as the harness renders it for the user invocation (body, skill directory, user arguments), immutable for the run.
- `t` — the execution state: a JSON object satisfying the state schema.
- `T_t` — the tail: the most recent stored messages of the branch under the prompt budget, whose newest messages are the current step's observation `O_t`. Earlier runtimes pinned `O_t` alone — the newest tool pair and the current user turn under a byte cap — and left everything older absent from the prompt.

The model replies with a state patch `Δt`, tool calls, or both. The runtime validates `Δt`, merges it into `t`, and lets the tool calls run.

Consequence: the prompt is bounded by the budget and the transcript by the steps, so the prompt stops growing with execution length while the transcript does not. The runtime before the tail claimed `O(1)` in the number of steps; the tail gives that up deliberately (ADR 0010), because the state alone could not carry a user turn it did not anticipate or a fact whose relevance arrived late.

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
   |                     +-- idle x5 -------------> idle ask, no exit
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
2. That skill is a procedure skill: it ships a `state.schema.json` beside its `SKILL.md` (section 5). The file is the opt-in marker; a file that declares no properties selects the runtime's default schema.
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
    "tested_hypotheses": { "type": "array", "items": { "type": "string" } },
    "knowledge": { "type": "object", "additionalProperties": true }
  },
  "additionalProperties": true
}
```

Rules:

- The top level must be an object.
- Types used: `string`, `number`, `boolean`, `array`, `object`, `null`.
- `additionalProperties` accepts `true`, `false` or a schema. It defaults to `true`, so a procedure can carry keys the schema does not name; `false` rejects undeclared keys; a schema validates every undeclared member against itself exactly like a declared key, with errors naming the member path (`knowledge.db_port`). Hazard keys, null deletion and all-or-nothing validation are unchanged for members.
- Optional `x-state` block for runtime parameters:

```
{
  "x-state": {
    "promptBudgetPercent": 30,
    "evictionChunkPercent": 25,
    "observationBytes": 32768,
    "stateBytes": 16384,
    "idleSteps": 3,
    "retries": 3,
    "volatile": ["discovered_flags", "tested_hypotheses"]
  }
}
```

The schema is authored once per domain, not per task. A skill without `state.schema.json` is an ordinary skill and never engages — the file is the opt-in marker. A file that declares no `properties` selects the runtime's default schema: `goal`, `working_dir`, `constraints`, `plan`, `findings`, `open_questions`, `next_step` and the `knowledge` bag, with `plan`, `findings`, `open_questions` and `next_step` volatile. A skill that ships only `x-state` params therefore needs no authored fields, and a mode-entry skill fits in one file plus one marker.

`x-state.volatile` names the declared keys expected to change on most steps. They ride in the scratch state; every other declared key stays in the state core (sections 6 and 7). Non-string entries of the list are dropped. Without an explicit list the runtime applies a heuristic that protects the cache prefix: array-typed declared keys and the planning keys (`plan`, `next_step`, `findings`, `open_questions`, `scratch`) are volatile, and every other declared key is core.

An object-typed declared key with no properties and open `additionalProperties` — the example's `knowledge` — is the knowledge bag (ADR 0006): it admits any JSON member, so a skill holds stable discovered facts without pre-enumerating their keys, and being declared and non-volatile it takes the state core, where its bytes cache and its object merge accrues facts key-wise without re-emission. A skill types the bag's members when it wants to by giving `additionalProperties` a schema; declaring anticipated discovery-array keys and leaving them off the volatile list freezes them into the core the same way.

## 6. Execution state

The state `t` is a JSON object. It starts as `{}` when a procedure engages.

Merge operator `⊕`, applied to each accepted patch:

- A key in `Δt` with a value other than `null` sets that key in `t`.
- A key in `Δt` with value `null` deletes that key from `t`, whatever its declared type: null is the typeless deletion operator, never a value.
- Keys absent from `Δt` are untouched.
- Merge is shallow and recursive only for objects: an object value merges key-wise, an array or scalar replaces.
- The root operator `"$append"` maps state keys to item arrays: `{"$append": {"findings": [items]}}` appends the items to each named key's current array instead of setting it whole; a missing key starts from an empty array, a key that holds a non-array value is replaced by the appended list, and an empty append on a key with no array to grow changes nothing — it does not materialize an empty array. It exists so a growing list does not have to be re-emitted in full on every step.
- The root operator `"$remove"` maps state keys to item arrays and removes every item matching a listed item, by value, from each named key's current array, leaving the rest and their order untouched; an item that is not present matches nothing, removing every item leaves an empty array, and a remove against a missing key or a key that holds a non-array value changes nothing — it does not materialize a key. It exists so retiring a known item does not have to re-emit the rest of the list.
- A nested null under a key absent from `t` deletes into nothing: no object holding nulls is created.

This is the paper's dictionary merge with null-deletion semantics, and it is what makes the model's most common failure mode — omitting a key it meant to keep — harmless.

Validation, on every patch, before merge:

- Valid JSON object, or the patch is rejected.
- Every key present in the schema validates against its declared type — null excepted, per the deletion rule above — or the patch is rejected. Null is a deletion only at the key level: an array element's null is a value and must satisfy the `items` schema like any other element. An operator payload validates like any value of its target key: item-wise against the array's `items` schema when the key declares one.
- The operators are root keys of the patch. `$append` and `$remove` each map state keys to item arrays; a root key that is both set and operated, or both appended and removed, rejects — one key carries one write per patch. Any other `$`-prefixed root key rejects as an unknown operator: the `$` namespace is reserved. The operators are legal only against array-typed keys: a declared key of any other type rejects by rule — `does not accept` — so the retry never chases the payload example. An operator may target an undeclared key, where the payload only has to be an array; operator-shaped objects below the patch root are plain data.
- Unknown keys are accepted when `additionalProperties` is true or absent; their values are not type-checked, but the banned shapes below still hold inside them. When `additionalProperties` is a schema, each undeclared member validates against it like a declared key, member path in the error; a member's null is still the deletion, and the hazard keys are still rejected first.
- The keys `__proto__`, `constructor` and `prototype` are rejected outright, at every depth — declared or not.
- A schema type this runtime does not read (for example an array-valued `type`, or a bogus value in hand-written JSON) rejects the patch with an unsupported-type error rather than passing silently.
- A rejected patch changes nothing. The runtime does not partially apply.

Persistence: after each accepted patch the runtime sends the state as two custom messages, the state core (`sh.omp.skill-state.core`) first and the scratch state (`sh.omp.skill-state.scratch`) behind it, each carrying its partition in `details.state` and rendered as labelled plain JSON, delivered as asides so they land at the next step boundary, before the next provider call. The split is schema-driven, by `x-state.volatile` (section 5), and an empty partition is still stored as a `{}` message, so the head's shape never varies. Both messages are stored in the transcript like any other, which is what lets the projection reuse them byte-for-byte (section 7). On `session_start`, `session_switch`, `session_branch` and `session_tree` the runtime re-derives engagement from the latest invocation on the branch and the procedure-spec, state-core and scratch-state messages that follow it, taking the last message of each type and merging `{ ...core, ...scratch }`; either state message missing means inert, so `/resume`, rewinds and tree navigation keep it.

The run's final state is the live state at `agent_end`. The runtime polls `ctx.isIdle()` every 20 ms for up to 2 s and then sends both state messages, core then scratch, as next-turn messages (`deliverAs: "nextTurn"`): the harness then appends them to context and history at once, with no turn started. Sent any earlier, while the harness is still inside the loop, a next-turn message is only held in memory until the next prompt, and `/resume`, `/new` or quitting before that prompt loses it. A queued follow-up prompt keeps the session busy past the budget, in which case the messages are sent anyway and the harness holds them for that prompt. The waiting copy is dropped if a patch is accepted in the meantime (it is stale) or if the engagement ends in that window (a session switch or `/clear`: a message sent after it would land in the wrong context).

Each commit is mirrored through `pi.appendEntry` as well: an entry the harness never sends to the LLM, carrying the same partitions and the same write stamp as the messages it mirrors. A re-derive reads the mirror, and a stored state message that disagrees with it is repaired by re-sending the head (ADR 0012). The messages stay the projection's source because the cache breakpoint anchors on them (section 7).

## 7. The projection

On every `context` event while engaged, the runtime returns a replacement message array containing, in order:

1. The runtime's operating rules, a custom message passed through unchanged.
2. `P`, the skill body as rendered for the invocation, a custom message passed through unchanged. The rendered skill prompt is used rather than the raw file so the user's invocation arguments stay in every step.
3. The state core, the declared keys the schema does not list as volatile, as labelled plain JSON — plain text by design, so the `elide` pass described in section 10 never targets it — the latest stored core message passed through unchanged. Changes only when a patch changes a core key.
4. **The tail**: the most recent stored messages of the branch, returned as the stored objects themselves, oldest first, under the prompt budget (section 9). It begins after the rules, `P` and the state core, sits before the scratch state — the head's four messages bracket it — and carries no injected live-state block, so the tail is the run's real conversation: user turns, assistant text and tool calls, tool results, skill-prompt customs, `state_update` calls and their results. Its newest messages are the step's observation `O_t`, which is why there is no separate observation window.
5. The scratch state, the volatile-listed keys plus every undeclared key, the latest stored scratch message returned as a shallow clone of itself with one added detail field, `details.perCall`. The copy deliberately differs from its stored counterpart so the harness marks it per-call (below); the field lives outside the content, so the model sees the same bytes either way. Its rendered content changes whenever the scratch keys do.
6. Pair tags and the window notice, derived from the tail. Each tailed tool result's projected copy carries a **pair tag**: four lowercase hex digits derived deterministically from the tool call id alone — FNV-1a, no memo state — prepended as the result's first text line, `[#xxxx tool]`. A re-derive after `/resume` or a rewind recomputes identical tags, so the model's references stay coherent across a resume. The tag bytes count toward the result cap (they are prepended before capping), the truncation marker stays at the cut end, and neither the markers nor the tag line are ever cut: the cap's floor is one tag line plus one marker per result. The step prompt then carries a per-call **window notice**: one developer line listing the tailed results' tags and tools oldest first — `tail oldest→newest: #a3f2 read, #b71c grep — oldest evict first when the prompt outgrows its budget` — with the drop rule stated as a rule, never as a prediction: which result evicts depends on the next step's result count, unknowable at projection time. It rides the existing per-call seam (section 16), before the consolidation ask and the idle ask, and is absent whenever the tail carries no tool result — the first step, a degraded step, or a step whose prompt carries no head. Stored results never carry tags and the notice is never stored: the transcript stays the unmutated record of the run.

The head is four messages: the rules, `P`, the state core and the scratch state, with the tail sitting between the core and the scratch. The rules, `P` and the core are stored transcript messages returned byte-unchanged; the scratch is stored transcript too but rides as its per-call copy (item 5); the tail is stored transcript as well, which is what makes it cacheable. The projection returns the stored objects themselves, with two exceptions: the scratch's per-call clone above, and the tailed tool results, whose projected copies gain a pair-tag line. The head is sent at engage and again after every compaction while engaged (`session_compact`), because the harness's cut can land after the original copies; the re-sent copies are byte-equal to the first except for the scratch clone, and the projection takes the last stored message of each type. The tail needs no such re-send: it is read from the branch, not from the harness's context, so a compaction cut cannot shorten it.

The order is not free. The scratch is volatile, so a per-call region placed early would poison every byte behind it; the tail sits after the core and before the scratch so the cached prefix reaches through it (ADR 0011).

The operating rules also reach the model on the invocation batch itself. `before_agent_start` fires at the batch's dequeue, before the skill prompt's `message_end` can engage, so the handler cannot consult engagement state; it answers with the rules message when the prompt announces a procedure skill. The harness's user-invocation announcement line names the invoked skill, and the state-schema check filters every other prompt, so an ordinary prompt matches nothing. The harness appends the returned message to the batch and stores it with the transcript; the copy is byte-equal to the head's rules. The first step runs on ordinary context plus this message; from the second step on the projection takes the stored head's copy, and step 1's copy is part of the tail like any other stored message, so the cache never sees a difference.

**Degraded steps.** While the head is intact, the projection never falls back to ordinary history. A step is degraded when the tail is empty — the head is in place and there is nothing behind it to show — and its prompt is the head plus a per-call **degradation notice**: one developer line stating that the execution state is intact and current and that no recent transcript is in the prompt, and asking the model to continue from the state. A degraded step is policy-neutral: it advances neither the idle counter nor the retry counter, while the model's reply on it is judged as any reply. A step whose prompt carries no head is not a degradation: the missing-head fallback to ordinary context stands unchanged. "Degraded step" names the projection gap only; the procedure's **degrade** (section 8, retries exhausted, self-disable) is a different failure and keeps its name.

Everything else is dropped: every injected live-state block — `goal-mode-context`, `plan-mode-context`, the eager-todo and mid-run-todo nudges, TTSR injections, and todo reminders — and every message the tail's budget has evicted. Nothing else is filtered, and that is the point of the tail: a second skill invocation, a human correction and the model's own earlier prose all reach the model, so a mid-run invocation is answerable without a succession protocol (ADR 0010).

The runtime never mutates the transcript. Evicted material remains on disk and in the branch; it is absent from the prompt and reachable through recall (section 8).

Caching. Prompt caching is positional: a breakpoint caches every byte before it, and a hit needs that whole prefix to match. The harness marks any message that is not byte-equal to its stored counterpart as per-call, and places one breakpoint on the newest message at or before the first per-call message. Items 1 to 4 are stored messages returned unchanged, so they are stable; the scratch clone is the first per-call message, and the breakpoint lands at the end of the tail. Every step is then a cache hit on tools, system prompt, rules, `P`, the core and the tail's already-seen messages, until a patch changes a core key and that step re-bills through the new core. Only the tail's newest messages, the scratch state and the per-call notices are re-billed. The tail's position is what makes that possible: after the scratch it would re-bill in full on every step, because the scratch changes on most steps and a per-call region poisons everything behind it (ADR 0011). The split is what lifts the breakpoint into the state at all: with the volatile keys riding in one full-state message, every step's patch would invalidate it and the breakpoint would fall back on `P`, caching only through the spec. A synthesised `P`, `t` or tail would not be cached at all: a message with no stored counterpart is per-call by construction, and `P` appended to the system prompt through `before_agent_start` lands after the volatile `<project-context>` block and outside the head breakpoint.

## 8. Producing and validating the patch

The patch travels as a `state_update` extension tool (ADR 0002), registered through the harness's public `registerTool` once at factory load — the harness's own recommended pattern — so the definition sits in the model's tool declarations from turn 0 and its presence never depends on engage ordering. The operating rules in the head describe the channel from the first step on; no procedure spec has to carry the calling convention itself, and the rules reach the model from the very first step through the `before_agent_start` delivery (section 7). Registration is permanent for the session: no unregister exists, and after a disengage a late call meets a graceful `no active procedure` error result instead of a crash. A session that never engages a procedure still carries the definition in its tool list, where a stray call can only ever meet that same graceful error.

The definition carries `strict: true` and a single wrapper argument `patch`, an unconstrained JSON object holding the whole Δt. It also sets `loadMode: "essential"`: under `tools.xdev` a discoverable tool mounts as an `xd://` device, and the patch would then travel as freehand `write` content instead of protocol-level JSON — the malformed-input class this channel exists to exclude. It also declares `concurrency: "exclusive"`: a reply's tool calls are scheduled together by default (mode "shared"), and the declaration makes each `state_update` call run alone, so nothing interleaves between the commit's re-validation and its asides. The harness preserves `strict: true` on tool definitions and sends it to both the Anthropic and OpenAI families, with automatic fallback when a provider rejects it. The state schema is enforced at apply time rather than in the tool's parameter schema, so one schema source stays authoritative.

Approval is zero-cost by decision: the definition declares `{ tier: "read", policy: "allow" }`, so even always-ask approval modes never prompt for a state write. A per-tool user deny still wins, because the harness's approval resolver is consulted first.

Ordering, and why all-or-nothing survives the channel change:

1. `assistant_message` fires once per finalized assistant message, before the message reaches agent context, persistence, `message_end`, or tool dispatch. The handler collects every `state_update` call's `patch` and folds them in declaration order against the state schema — each patch applies to the previous one's result — so one invalid patch anywhere in the batch refuses the whole step.
2. On failure it sets a pending-failure flag for this step and increments the retry counter.
3. `tool_call` fires next, at argument-prep time, for every call of the batch — the `state_update` call included. While the flag is set, the handler blocks every call and returns the validation error as the reason. Because the `state_update` call itself is blocked, no tool of the step has executed by the time the batch is refused.
4. When the patch is valid, the `state_update` execute runs with the rest of the batch: it re-validates defensively (an impossible failure would come back as the exact error in a failed tool result), merges the patch, commits the state, and asides land the new state's two messages, core then scratch, at the next step boundary, before the next provider call.
5. The model receives the block reason and re-emits. A blocked call does not execute and emits no result hook.

A step with no `state_update` call is legal and means an empty patch. A batch whose fold leaves the state structurally unchanged commits nothing and sends nothing (the `changed` verdict of `applyPatch`, shared by the step policy and the tool executes). Only an *invalid* patch blocks.

The two halves of that ordering have names (CONTEXT.md "Fold", "Commit"): the *fold* is the step policy's validation in `assistant_message`, which folds the batch's patches into a candidate state, discards it and yields the step's verdict only; the *commit* is each `state_update` execute's one write, applied against the state the previous commit left. The fold is not a staging area — nothing it computes is replayed — and the two agree by construction: the same patches in the same declaration order against the same intermediate states. That agreement is the fold-versus-per-call-commit equivalence (section 18).

Retry and degrade:

- Up to `retries` (default 3) consecutive invalid patches: block and re-prompt.
- On the `retries`-th failure the runtime disengages, notifies the user, and leaves the transcript to speak for itself. From then on the session is ordinary.

The finish protocol is unchanged: a reply with no tool call still ends the run. Skills teach one final consolidating `state_update` in the step before it; because that patch arrives as a tool call, its asides are already stored during the run, and the run's final state is simply the live state at `agent_end`, settled as next-turn messages once the session is idle (section 6).

No JSON repair exists on this channel. Tool arguments are protocol-level JSON, so the freehand block's malformed-JSON failure class (the paper's measured ~12% on small models) does not exist here, and silent repair could produce different state than the model meant, where the block-retry-degrade path reports exact errors.

The `state_recall` tool (ADR 0010) is the read-back channel, registered beside `state_update` at factory load with the same treatment — `strict: true`, zero approval, `loadMode: "essential"`, `concurrency: "exclusive"`, one wrapper argument, here `query`. It reads the current session's own transcript file, matches the query against the entries' text — a case-insensitive substring match, taken in file order — and returns the matches oldest first, verbatim: nothing is summarised. The matches are packed greedily under a cumulative cap of 16,384 bytes (`RECALL_RESULT_BYTES`); the first match that would overflow the cap ends the pack, and when matches were left out the result carries, after the matches and outside the cap, the marker `recall cap 16384 bytes reached — oldest matches shown; narrow the query to see the rest`. A session with no transcript file on disk has nothing to recall and the tool answers with an empty result, not an error. Recall is never engagement-gated, and it reads the current session's transcript only (section 19).

## 9. Caps

### Result cap

A tailed tool result's own text is capped at `observationBytes`, default 65536. The tail's total is bounded by the prompt budget below.

- The cap applies to the result's text, not to the tail as a whole.
- Over the cap, the runtime truncates from the end of the result and inserts a marker naming what was cut and how to re-read it.
- Markers are never cut, and neither is the pair-tag line (section 7): the tag is what still identifies a fully cut result and what the window notice names. The cap's floor is one tag line plus one marker.
- The cap is per result, not cumulative; the budget is the cumulative bound.

### Tail budget

The tail is bounded by the prompt budget: `promptBudgetPercent` of the model's context window (`ctx.getContextUsage()`), default 30, minus the head, the scratch state and a reserve. While the projected tail exceeds that budget, the runtime evicts from the front one chunk at a time, the chunk being `evictionChunkPercent` of the budget (default 25) and always at least one message, so the front of the tail is stable for many steps and the cached prefix survives between evictions (ADR 0011). Eviction never touches the head, the scratch, or the newest message, so the prompt may exceed the budget by the newest message's size; the per-result cap bounds that excess.

### State cap

The execution state is capped at `stateBytes` — the summed byte length of the two rendered state messages, the core's and the scratch's — default 0, which disables the cap; set per skill in `x-state`. The cap is soft: while the state measures over it, the next projected step's prompt carries a per-call developer nudge asking the model to consolidate the state with a `state_update` patch (drop superseded findings; `null` deletes a key). The nudge fires once per over-cap episode and re-arms when a commit lands the state back under the cap. The cap never blocks a step or a patch, and it never disengages or degrades the procedure: it is a signal, not a limit.

### Recall cap

The `state_recall` result is capped at 16,384 bytes (`RECALL_RESULT_BYTES`), cumulative over the packed matches; the marker naming the cap rides after the matches, outside the cap (section 8).

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

Three triggers, all leading to the same reset (clear `t`, clear engaged flag, stop projecting):

1. **New session.** `/new` starts one, firing `session_before_switch` and then `session_switch` with reason `new`; `session_start` fires only on a cold load. This is the intended ending, and the runtime tells the user so (section 12). On every `session_start` and `session_switch` the runtime re-derives engagement from the branch rather than resetting blindly: an empty branch is inert; a branch holding a user skill invocation for a procedure skill followed by its procedure-spec message and its two state messages, the latest core and the latest scratch, re-engages with the merged state, and either state message missing is inert (the spec is read back from the branch so no file is re-read). That is what makes `/resume` restore `t` while `/new` starts clean.
2. **Context reset.** `/clear` keeps the session and drops messages in place, and emits nothing to extensions. The `input` event runs before command interpretation and does see the raw text, so the runtime disengages on `/clear` directly.
3. **Session change.** A switch, a rewind or a fork all land in a different session id, so `session_before_switch` and `session_before_branch` end the outgoing engagement with the usual disengage notice. `session_switch`, `session_branch` and `session_tree` then re-derive engagement from the branch now loaded: a rewind that lands after the invocation re-engages with that branch's state, one that lands before it stays inert, and a fork re-derives like any other branch.

**Idleness does not end the procedure.** While the state goes unchanged the model's edits are not required for the run to stay coherent, so the runtime never stands down on its own: `idleSteps` consecutive steps with no patch or with a patch that leaves the state unchanged raise one per-call developer ask per episode, naming how long the state has stood still and asking the model to record a meaningful fact — a reminder, never a deadline — and the ask is never stored and never re-sent from history. A step whose provider call carried no stored head does not count: the first step carries the rules through the `before_agent_start` delivery (section 7) but runs before the engage asides land, and the step after a compaction can run before the re-sent head lands, so the rules are missing from its prompt in that case — no head means no count and no ask.

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
| Oversized tool result | result cap | truncate from the end of the result, insert a marker |
| Provider rejects the prompt shape | provider error surfaced to the session | the harness's own retry and compaction paths apply; the runtime does not intercept them |
| Model stops updating the state | `idleSteps` idle steps | one idle ask per episode; the procedure stays engaged |
| Head message missing on rebuild | invocation without a following procedure-spec message or either state message | stay inert: there is no head to project |
| Empty tail | head intact, no messages behind it | project the head and a degradation notice |

Degrade is terminal for the session. The user gets ordinary history-based execution back, which is always correct, only more expensive.

## 15. Parameters and defaults

| Parameter | Default | Source |
| --- | --- | --- |
| `promptBudgetPercent` | 30 | schema `x-state`, else runtime default |
| `evictionChunkPercent` | 25 | schema `x-state`, else runtime default |
| `observationBytes` | 65536 | schema `x-state`, else runtime default |
| `idleSteps` | 5 | schema `x-state`, else runtime default |
| `retries` | 3 | schema `x-state`, else runtime default |
| `stateBytes` | 0 (disabled) | schema `x-state`, else runtime default |
| `volatile` | heuristic: array-typed and planning keys | schema `x-state.volatile`, else runtime heuristic |
| `observationWindow` | deleted | the tail replaced it (section 7) |
| dropped blocks | all live-state blocks | fixed in v1 |

## 16. Harness surfaces used

Every mechanism above is public extension API. Nothing else is touched.

| Need | Surface |
| --- | --- |
| per-step rewrite | `context` event; receives `AgentMessage[]` before `convertToLlm`, so `customType` is still visible, and its replacement never rewrites stored history |
| nudge at the policy thresholds | `stepPrompt`, the `context` handler's one call: it projects the prompt, notes whether the stored head reached it, and appends the turn's per-call developer lines in a fixed order — the window notice first (the tailed tool results' pair tags and tools oldest first with the drop rule, on tool-result steps only, section 7), then the consolidation ask latched once per over-cap episode (`capNudged`, re-armed when a commit lands back under `stateBytes`), then the idle ask once per idle episode (section 11); all of them ride the event's replacement, are never stored and never re-sent from history (sections 9 and 11) |
| validate before tools run | `assistant_message`, awaited before tool dispatch |
| block a batch | `tool_call`, may block with a reason |
| offer the state-write channel | `registerTool` with the strict, zero-approval `state_update` definition, registered once at factory load (section 8) |
| deliver the rules on the first step | `before_agent_start` returning the rules message on the invocation batch; the harness's announcement line names the invoked skill (section 7) |
| persist the head: the state core, the scratch state, `P`, rules | `sendMessage` with `deliverAs: "aside"`, plus `ctx.sessionManager.getBranch()` to rebuild |
| persist the run's final `t` | `agent_end`, then `sendMessage` with `deliverAs: "nextTurn"` once `ctx.isIdle()` (section 6) |
| re-send the head after a compaction | `session_compact`, then `sendMessage` with `deliverAs: "aside"` during a run or `"nextTurn"` when `ctx.isIdle()` (section 7) |
| keep the head and tail cacheable | return the stored rules, spec, core and tail unchanged and the scratch as its per-call copy, so the provider anchors the breakpoint at the end of the tail (ADR 0011) |
| own compaction | `session_before_compact`, lazily registered |
| detect `/clear` | `input` |
| detect a user skill invocation | `message_end`; the harness's own skill-prompt message, checked for `attribution === "user"` |
| detect a session change | `session_before_switch`, `session_before_branch`; `session_start`, `session_switch`, `session_branch`, `session_tree` re-derive engagement from the branch (section 11) |
| read the schema | `skill://<name>/state.schema.json`, plus `pi.pi.getActiveSkills()` |
| visibility | `ctx.ui.notify`, `registerMessageRenderer` |
| build the tail | `context` event plus `ctx.sessionManager.getBranch()`; the tail is read from the branch, so a harness compaction cannot shorten it |
| read the prompt budget | `ctx.getContextUsage()`, `{ tokens, contextWindow, percent }` |
| store the durable mirror | `pi.appendEntry`, an entry the harness never sends to the LLM (ADR 0012) |
| read back dropped transcript | the `state_recall` tool over the session's own JSONL file |

### The harness register

The surfaces table lists the public extension API; the register lists the behaviours of the running harness this plugin relies on, which are not all API. Each row was verified against the installed artifact — `@oh-my-pi/pi-coding-agent@18.10.3`, with `@oh-my-pi/pi-agent-core` and `@oh-my-pi/pi-ai` at the same version, the bun-global install behind `omp --version` (verified 2026-10-13) — whose exports map runs the shipped `src/` tree, at the source location given. A behaviour that cannot be verified from the installed artifact is marked `inference` in its row, never stated as fact; a harness upgrade is reviewed against this table row by row.

| Behaviour | Relied on at | Verified against |
| --- | --- | --- |
| A reply's tool calls are scheduled concurrently by default, mode "shared": shared calls start once the last exclusive call has finished and then run together; an exclusive call starts only when everything before it has finished. | the patch channel declares concurrency: "exclusive" against this default (section 8) | `@oh-my-pi/pi-agent-core@18.10.3 src/agent-loop.ts:3770-3796` |
| A prompt message is marked a per-call message when it differs from its stored counterpart — a Bun.deepEquals comparison — and for no other reason; the mark itself is a symbol that never persists or reaches the provider wire. No details field or other content key participates. | the scratch copy's added details.perCall field is only a way to make that comparison fail (section 7, CONTEXT.md "Per-call message") | `@oh-my-pi/pi-coding-agent@18.10.3 src/extensibility/extensions/runner.ts:2035, 2042-2050; mark: @oh-my-pi/pi-ai@18.10.3 src/utils/block-symbols.ts:170-191` |
| Event handlers cannot be unregistered: every pi.on overload returns void, and the only unregister API removes model providers, never handlers. (The extension-to-extension pi.events bus does return an unsubscribe; that is a different surface.) | the compaction hook is registered lazily, on the first engage, because registration is permanent (section 10, ADR 0001) | `@oh-my-pi/pi-coding-agent@18.10.3 src/extensibility/extensions/types.ts:1527-1545, 1832` |
| Registering a session_before_compact handler disables speculative compaction only: the speculation path yields while handlers exist ("a speculated result would bypass their veto"), blocking compaction still runs them, and the effect lasts exactly as long as the session, which builds its own extension runner. | the lazy registration's cost is scoped to the session (section 10, ADR 0001) | `@oh-my-pi/pi-coding-agent@18.10.3 src/session/session-maintenance.ts:2099-2101; per session: src/sdk.ts:3306-3331` |
| A tool's load mode is presentation-only: it decides top-level presence versus mounting as an xd:// device and deferral under code mode; no approval or availability gate reads it. | state_update's loadMode: "essential" keeps the patch protocol-level JSON in every presentation (section 8, ADR 0002) | `@oh-my-pi/pi-coding-agent@18.10.3 src/extensibility/custom-tools/types.ts:206-207, src/session/code-mode.ts:115, src/tools/xdev.ts:85-88` |
| The hook order the patch path relies on: the context projection runs before convertToLlm on every provider request; the assistant_message transform is awaited once the message is final and before it reaches context, persistence, or tool dispatch; tool_call fires at argument-prep, before approval and scheduling; scheduling resolves last. | the fold, the block, and the commits happen in this order (section 8) | `@oh-my-pi/pi-agent-core@18.10.3 src/agent-loop.ts:1896-1900, 2243-2248, 3074-3091, 3770-3796` |
| `getContextUsage()` returns the active model's live estimate `{ tokens, contextWindow, percent }`, anchored to the last provider-reported usage when available. | the prompt budget is a fraction of `contextWindow` (section 9, ADR 0011) | `@oh-my-pi/pi-coding-agent@18.10.3 src/extensibility/extensions/types.ts:387, 491; src/session/agent-session.ts:12446-12448` |
| `appendEntry(customType, data)` appends a `CustomEntry { type: "custom", customType, data }` that `getEntries()`/`getBranch()` return like any other entry, and that never reaches the LLM. | the durable mirror (section 6, ADR 0012) | `@oh-my-pi/pi-coding-agent@18.10.3 src/session/session-manager.ts:3521-3525, src/session/session-entries.ts:180-184, src/extensibility/extensions/types.ts:1602-1603` |
| A session's transcript is a JSONL file, one entry per line, greppable from disk at `~/.omp/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl`. | the recall tool reads the current session's own file (section 8) | `@oh-my-pi/pi-coding-agent@18.10.3 docs/session.md:41-43, 63-68` |

## 17. Packaging

```
omp-skill-state/
  package.json          "omp": { "extensions": ["./src/index.ts"] }
  src/index.ts          the harness adapter: event registrations, sends, blocks, notices
  src/projection.ts     the projection (pure message assembly)
  src/branch.ts         pure reads over the stored branch (re-derive scan, state pairs, compaction cut)
  src/procedure.ts      the procedure record and the step policy (patch outcomes, head, compaction)
  src/state.ts          the execution state module: schema and params loading, patch validation, merge and apply, the core/scratch split (volatileKeys, splitState)
  src/messages.ts       the message vocabulary: the head message types, the invocation constant and its predicate, the announcement pair, the state renderer and the core and scratch state builders
  src/recall.ts         the recall read: pure match-and-pack over the transcript's JSONL lines, oldest first, under the 16,384-byte cap
  src/types.ts          shared types: the harness message union and the structural object predicate
  test/*.test.ts        unit tests (bun test), one per source module; test/adapter-*.test.ts drive the factory through the fake session, one file per concern
  test/fake-session.ts  the fake omp session for the adapter tests (branch, delivery timing, sends)
  test/harness.ts       the adapter suites' shared harness: per-suite skill fixtures, the engaged/projecting session builders, assertion builders
  test/entries.ts       one home for the stored-branch entry builders the fake session and the suites seed with
  test/skill-fixtures.ts the shared test fixture writing skill directories (makeSkill)
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

- merge operator: set, null-delete (any declared type), nested object merge, array replace, `$append` onto existing, missing and non-array keys, `$remove` onto existing, missing and non-array keys, removal of an absent item, absent-key preservation.
- the state split: explicit `x-state.volatile` parsing (non-string entries dropped), the unannotated-schema heuristic (array-typed and planning keys volatile), and the disjoint core/scratch partition.
- schema validation: each type, unknown keys under both `additionalProperties` values, non-object top level.
- projection assembly: exact message order and roles; each dropped block type; the tail, its pair tags and the window notice; the byte cap and its marker.
- branch reads: the re-derive scan (latest invocation wins, an incomplete head is inert) and the compaction cut.
- step policy: each reply outcome (none, ok, block, ended by degrade), the counters and their resets, the fold-versus-per-call-commit equivalence, the nudge seam (project, note and nudge in one call, with cap episode, re-arm and idle ask by direct calls), the head and the compaction result.
- first-step rules delivery on engage, and its absence for non-procedure prompts, agent-attributed invocations, subagents and mid-procedure batches.

The `test/adapter-*.test.ts` suites drive the factory through a fake omp session (`test/fake-session.ts`, assembled by `test/harness.ts`): one factory with N sessions keyed by id, each owning its branch, sends, notices and idle flag. One adapter file per concern — lifecycle (engage, disengage, re-derive, first-step rules, idle), the patch channel (patch loop, `state_update` registration), compaction ownership, the projection seam — and each claim has one owner: the step policy, the projection assembly and the message vocabulary are the unit suites' claims, and the adapter keeps one wiring witness per behavior (event order, delivery timing, storage effects) instead of a second copy of the policy. The fake auto-dispatches the harness event order inside one verb, assembles the context of each provider call from its branch, captures `registerTool` definitions, and models delivery timing: messages sent while busy flush at the end of the current step (so the stored head after engage lands at the first step boundary, while the first step's rules come from the `before_agent_start` delivery on the batch itself), messages sent while idle are appended at once, a reply with no tool call ends the run, and a call whose name has a captured definition runs that definition inside the step, recording its own result. The delivery model is the fake interface contract; `docs/verification.md` remains the real-session ground truth.

Against a real session (run G and the nudge probe in `docs/verification.md`; the invalid-patch refusal occurred in run G, the degrade path did not occur and rests on the unit tests, and the `/new`, `/clear` and rewind outcomes are in the doc's git history):

- engage on a user `/skill:` for a schema-bearing skill; stay inert for a skill without one; stay inert for a model-initiated `read skill://…`.
- invalid patch blocks the batch and the retry recovers.
- three failures degrade and notify.
- `t` survives `/resume` and a rewind.
- compaction while engaged produces a state summary and makes no summarizer call, and speculative compaction is off from that point.
- `/new` and `/clear` both disengage.
- prompt size stays inside the budget across a long run: assert the reported input tokens per step stay under `promptBudgetPercent` of the window and sawtooth at evictions.

The same suites also carry the redesign's claims: the tail's assembly (order, the head's own messages excluded, the live-state filter, the budget, chunked eviction), the degraded step (head intact, tail empty), the durable mirror and its repair path, the budget read from `ctx.getContextUsage()`, and the recall tool's read and its result cap.

## 19. Out of scope

- Multi-agent procedures with concurrent state writes and conflict resolution.
- Automatic schema discovery for skills that do not declare one.
- Any change under the harness source tree.
- Multiple concurrent procedures per session; summarization of dropped history — recall reads it back verbatim instead (section 8).
- Positional array editing beyond the value-keyed `$append` and `$remove` operators (no positional splices, no per-index edits, no pop-like removal of the head or tail).
- JSON repair in any form; `setActiveTools` registration gymnastics.
- Hard enforcement of the state cap (the nudge is the only sanction, by decision).
- Cross-session recall: `state_recall` reads the current session's transcript only.
- Ambient engagement: the runtime still engages only on a user invocation of a procedure skill; the always-on trigger is deferred (ADR 0010).

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

The V3 change (window awareness, issue #30) made the runtime stop being vague about its own mechanics. A long real session showed the model guessing which observations were still prompt-resident — the bundled zstate skill said "a few steps" while the real value, six pairs, lived only in the schema — and the state drifting into an append-only diary, facts superseding one another with no visible deadline to distill by. Three additions answered that, all riding the per-call region so cost and the cache ceiling are unchanged: the operating rules state the exact window count, interpolated from the procedure's loaded params at engage, the first-step copy and the stored head copy byte-equal because both build from params loaded from the same schema file; each windowed tool result's projected copy gains a pair tag, four hex digits derived by FNV-1a from the tool call id alone, so tags are a pure function of the branch and a re-derive recomputes them identically with no memo state; and a per-call window notice lists the window's tags oldest first with the drop rule, appended by the step-prompt seam before the consolidation ask and the idle warning — data before policy. The notice states the drop rule, never a prediction: which pair expires depends on the next step's result count, unknowable at projection time. Rejected alternatives, recorded in the issue to prevent revisiting: content-derived tags (lose composition stability for a marginal re-read nicety), random memoized tags (nondeterministic across re-derive, need storage), expiry prediction (impossible), tags as separate messages between a tool call and its result (breaks provider sequence rules), and per-step re-firing of the consolidation ask (contradicts the recorded soft-cap decision). No ADR: the change fails the hard-to-reverse gate, and sections 5, 7 and 16 carry the reasoning.

The V4 change (ADR 0010-0012) turns the runtime from a procedure executor into a bounded context manager. V3 was coherent inside one procedure and blind outside it: a mid-run skill invocation was dropped by `message_end` and filtered out of the prompt, and a fact whose relevance arrived late had no route in. The `beta` branch's answer — succession with declared carry, a ride notice, a schema-less exit — was protocol where visibility was missing, so that line is abandoned rather than merged, and its numbers stay spent.

Five decisions, three ADRs:

- **The tail** (ADR 0010): the projection carries the most recent stored messages behind the state core, byte-unchanged and under a budget, so recency and anything the state did not record are simply visible. The observation window collapses into it; the window walk, the pair-pairing rule and the degraded-window path are deleted, and a degraded step narrows to "head intact, tail empty".
- **Recall** (ADR 0010): a `state_recall` tool reads back what the tail evicted, from the session's own transcript, which keeps the lossiness recoverable rather than absolute.
- **The layout** (ADR 0011): `rules, P, core, tail, scratch, observation`, so the cached prefix reaches through the tail; the budget is a fraction of the window and eviction is chunked.
- **The durable mirror** (ADR 0012): the state keeps its stored messages as the projection's source and gains an `appendEntry` mirror that no harness pass rewrites.
- **Adopted from the abandoned branch**: state reads order by write stamp with branch position as the final tiebreak (the `beta` branch's ADR 0008), because a parked next-turn send can land after a newer commit and time-travel the projection. Its module split is not adopted: this change moves those boundaries anyway.

Everything in this document is implemented. Acceptance for the redesign waits on four classes of real session — an ordinary coding session, a long research run, trajectory-as-objective work (an audit, "what changed and why", debug provenance), and a multi-skill session with a mid-run second-skill invocation — each recorded by the user and read afterwards, not a synthetic session harness; the measured figures land in `docs/verification.md` and are pending until then.
