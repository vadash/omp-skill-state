# Skill State

A runtime for omp that executes a procedural skill against an explicit execution state and a bounded tail of the conversation, instead of a growing transcript. It exists because prompt size and stale facts both grow with execution length in ordinary history-based runtimes.

## Language

**Procedure**:
A single run of a skill under the skill-state runtime. The procedure starts when the user invokes its skill and ends when the runtime disengages.
_Avoid_: task, job, workflow, session

**Procedure skill**:
A skill that declares a state schema. Only these can start a procedure.
_Avoid_: stateful skill, state skill

**Skill invocation**:
The user's invocation of a skill: a user-attributed message the harness stores, naming the invoked skill. A procedure starts when the invocation names a procedure skill in the main agent's session. A model-initiated skill read is not an invocation.
_Avoid_: trigger, slash command, skill call

**Mode-entry skill**:
A procedure skill whose spec carries no task of its own. The task is the text the user gives with the invocation, and the spec says only how to work under the runtime. The bundled `zstate` skill is one.
_Avoid_: wrapper skill, meta skill, generic skill

**Procedure spec**:
The immutable instruction text of the procedure, taken from the skill body and held as `P`. It never changes during the run.
_Avoid_: prompt, instructions, spec

**State schema**:
The declarative shape a procedure's execution state must satisfy, shipped beside the skill as `state.schema.json`.
_Avoid_: type, contract, model

**Default schema**:
The schema a procedure skill gets when its state file declares no properties: a general-purpose set of keys plus a knowledge bag, so a skill can opt in without authoring its own.
_Avoid_: fallback schema, auto schema

**Execution state**:
The structured value `t` holding everything the procedure needs from the past. It is the only thing that survives a step.
_Avoid_: memory, scratchpad, context, blackboard

**State patch**:
The model's proposed change to the execution state, `Δt`. It is a JSON object merged into the state, never a replacement of it.
_Avoid_: update, diff, mutation
The fixed tool name `state_update` (ADR 0002) is exempt from the avoid-list: it is the channel's registered name, not a glossary synonym.

**Operator**:
A `$`-prefixed root key of a state patch that carries list semantics instead of setting a key. Exactly two exist: `$append` and `$remove`, each mapping state keys to item arrays; a patch that both sets and operates on one key, or appends and removes one key, rejects. Any other `$`-prefixed root key rejects as an unknown operator: the `$` namespace is reserved.
_Avoid_: op envelope, rider, modifier

**Fold**:
The step policy's validation of a reply's state patches: folded in declaration order into a candidate state that is then discarded. It yields the step's verdict only, never a committed state.
_Avoid_: merge, apply, replay

**Commit**:
The one write of a merged state into the procedure, made per state patch against the state the previous commit left. The fold and the commits apply the same patches in the same order; their agreement is the fold-versus-per-call-commit equivalence.
_Avoid_: save, persist, write

**State core**:
The part of the execution state expected to hold for many steps, sent as its own stored message so the cached prompt prefix reaches into the state.
_Avoid_: stable state, persistent keys, core

**Scratch state**:
The volatile remainder of the execution state, the keys that change on most steps, sent as its own stored message behind the state core.
_Avoid_: working set, hot keys, delta

**Knowledge bag**:
A declared object-typed state key left open to any JSON value, where a skill holds stable discovered facts. It merges key-wise, lives in the state core, and survives a re-derive without any extra persistence. The bundled `zstate` skill carries one as `knowledge`.
_Avoid_: memory, fact store, dict

**State pair**:
The two stored messages holding one committed execution state: the state core followed immediately by the scratch state. A scratch closes the pair its preceding core opened.
_Avoid_: checkpoint, checkpoint pair, head pair

**Durable mirror**:
The entry `pi.appendEntry` writes for each committed state. It never enters the model's prompt; re-derive reads it and repairs a stored state message that disagrees with it.
_Avoid_: backup, journal, sidecar

**Observation**:
The environment output for the current step, `Oₜ`. It is the newest part of the tail — the most recent stored messages in the prompt.
_Avoid_: result, output, feedback

**Tail**:
The most recent stored messages behind the state core in the projection, returned byte-unchanged under the prompt budget. It is what keeps the conversation and anything the state did not record visible, and it is not the transcript: what it drops leaves the prompt.
_Avoid_: window, history, recent messages, transcript

**Prompt budget**:
The share of the model's context window a projected prompt may use, 30% by default. The tail gets what the head, the scratch state and the reserve leave.
_Avoid_: cap, limit, max tokens

**Eviction**:
The tail dropping its oldest messages when the budget is exceeded, in one chunk at a time rather than one message per step.
_Avoid_: truncation, pruning, expiry

**Recall**:
Reading dropped history back on demand, verbatim, through the `state_recall` tool. Nothing is summarised.
_Avoid_: retrieval, search, lookup

**Pair tag**:
The short label minted per tailed tool result: four hex digits derived from the tool call id, prepended to the projected tool result's text as `[#xxxx tool]`. Recomputed from the id every projection, so it is stable for as long as the result rides the tail; the stored transcript never carries it. Modeled on the harness's hashline tags, but not one.
_Avoid_: hex header, block id, hashline tag

**Window notice**:
The per-call developer line appended after the tail each step, listing the tail's tagged tool results oldest first. It states the eviction rule — the oldest messages leave first when the prompt outgrows its budget — and never predicts which message expires. Unlike a nudge it fires on every step that tailed a tool result, not when a threshold is met; like a nudge it is never stored.
_Avoid_: expiry line, TTL banner, watermark

**Degraded step**:
A step whose head is intact but whose tail is empty. The projection still never sends ordinary history; only a missing head does that.
_Avoid_: fallback step, raw-history step

**Step**:
One provider call. A step's `state_update` patches fold in order into one merged state change, beside one batch of tool calls and one set of observations.
_Avoid_: turn, iteration, round

**Projection**:
The per-step rewrite that replaces the message list sent to the model with the triple spec, state, observation. The stored transcript is never changed by it.
_Avoid_: compaction, truncation, filtering

**Head**:
The stored custom messages the projection pins at the front of every prompt: the operating rules, the procedure spec, the state core and the scratch state. Sent at engage and again after every compaction; the stable messages are byte-equal so the provider's prefix cache holds across the cut.
_Avoid_: preamble, prefix, context

**Cache ceiling**:
The prompt prefix two consecutive steps can share. It ends at the first prompt message the step changed, so it bounds what caching can save regardless of provider.
_Avoid_: cache hit rate, prefix limit

**Per-call message**:
The harness's mark for a prompt message that differs from its stored counterpart. A per-call message never anchors the durable cache breakpoint, and its presence moves that breakpoint to the newest stable message before it.
_Avoid_: synthesized message, ephemeral message

**Nudge**:
A per-call developer message appended to the projected prompt when a policy threshold is met: the consolidation ask while the execution state is over its `stateBytes` cap, and the idle ask while the model has stopped editing the state. It is never stored and never re-sent from history.
_Avoid_: warning, reminder, injection

**Idle**:
The model going `idleSteps` consecutive steps without changing the execution state. It raises one ask per episode and never ends the procedure.
_Avoid_: timeout, stall, inactivity

**Consolidation**:
The ask the over-cap nudge makes: one state patch that brings the execution state back under `stateBytes`, by dropping superseded entries or null-deleting keys it no longer needs. The nudge fires once per over-cap episode and re-arms when a commit lands the state back under the cap.
_Avoid_: prune, cleanup, shrink

**Cut**:
The compaction's first kept entry. While engaged it is the current step, the latest assistant message on the branch, not the turn-sized tail the harness proposes.
_Avoid_: boundary, checkpoint, kept tail

**Final state**:
The state accepted from a reply with no tool call, which ends the run. It is stored as next-turn messages once the session is idle, not as asides.
_Avoid_: result, answer, summary

**Branch**:
The stored entries from the session root to the current leaf, as the harness keeps them. The runtime reads it in two places: re-derive scans it for the latest procedure and its head, and the compaction cut is its latest assistant message.
_Avoid_: history, log

**Re-derive**:
Rebuilding engagement from the branch on session start, switch, rewind or tree navigation: no user invocation of a procedure skill followed by its procedure-spec message and both state messages means inert; otherwise engaged with their merged state.
_Avoid_: restore, rehydrate, reload

**Engage**:
The runtime taking control of the projection for a procedure.
_Avoid_: activate, enable, start

**Disengage**:
The runtime returning the session to ordinary history-based execution.
_Avoid_: deactivate, stop, end

**Degrade**:
The self-disable that a procedure reaches when the model stops producing valid state patches. It is the only failure exit.
_Avoid_: fail, abort, bail
