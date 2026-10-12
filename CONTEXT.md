# Skill State

A runtime for omp that executes a procedural skill against an explicit execution state instead of a growing conversation. It exists because prompt size and stale facts both grow with execution length in ordinary history-based runtimes.

## Language

**Procedure**:
A single run of a skill under the skill-state runtime. The procedure starts when the user invokes its skill and ends when the runtime disengages.
_Avoid_: task, job, workflow, session

**Procedure skill**:
A skill that declares a state schema. Only these can start a procedure.
_Avoid_: stateful skill, state skill

**Mode-entry skill**:
A procedure skill whose spec carries no task of its own. The task is the text the user gives with the invocation, and the spec says only how to work under the runtime. The bundled `zstate` skill is one.
_Avoid_: wrapper skill, meta skill, generic skill

**Procedure spec**:
The immutable instruction text of the procedure, taken from the skill body and held as `P`. It never changes during the run.
_Avoid_: prompt, instructions, spec

**State schema**:
The declarative shape a procedure's execution state must satisfy, shipped beside the skill as `state.schema.json`.
_Avoid_: type, contract, model

**Execution state**:
The structured value `t` holding everything the procedure needs from the past. It is the only thing that survives a step.
_Avoid_: memory, scratchpad, context, blackboard

**State patch**:
The model's proposed change to the execution state, `Δt`. It is a JSON object merged into the state, never a replacement of it.
_Avoid_: update, diff, mutation

**State core**:
The part of the execution state expected to hold for many steps, sent as its own stored message so the cached prompt prefix reaches into the state.
_Avoid_: stable state, persistent keys, core

**Scratch state**:
The volatile remainder of the execution state, the keys that change on most steps, sent as its own stored message behind the state core.
_Avoid_: working set, hot keys, delta

**Observation**:
The environment output for the current step, `Oₜ`. It is the only past-free material the model receives besides the spec and the state.
_Avoid_: result, output, feedback

**Observation window**:
The number of most recent tool pairs the projection pins as the step's observation, under one shared byte cap.
_Avoid_: history window, result buffer

**Step**:
One provider call. A step produces at most one state patch, one batch of tool calls, and one set of observations.
_Avoid_: turn, iteration, round

**Projection**:
The per-step rewrite that replaces the message list sent to the model with the triple spec, state, observation. The stored transcript is never changed by it.
_Avoid_: compaction, truncation, filtering

**Head**:
The stored custom messages the projection pins at the front of every prompt: the operating rules, the procedure spec, the state core and the scratch state. Sent at engage and again after every compaction; the stable messages are byte-equal so the provider's prefix cache holds across the cut.
_Avoid_: preamble, prefix, context

**Cache ceiling**:
The prompt prefix two consecutive steps can share. It ends at the first head message the step changed, so it bounds what caching can save regardless of provider.
_Avoid_: cache hit rate, prefix limit

**Per-call message**:
The harness's mark for a prompt message that differs from its stored counterpart. A per-call message never anchors the durable cache breakpoint, and its presence moves that breakpoint to the newest stable message before it.
_Avoid_: synthesized message, ephemeral message

**Cut**:
The compaction's first kept entry. While engaged it is the current step, the latest assistant message on the branch, not the turn-sized tail the harness proposes.
_Avoid_: boundary, checkpoint, kept tail

**Final state**:
The state accepted from a reply with no tool call, which ends the run. It is stored as a next-turn message once the session is idle, not as an aside.
_Avoid_: result, answer, summary

**Branch**:
The stored entries from the session root to the current leaf, as the harness keeps them. The runtime reads it in two places: re-derive scans it for the latest procedure and its head, and the compaction cut is its latest assistant message.
_Avoid_: history, log

**Re-derive**:
Rebuilding engagement from the branch on session start, switch, rewind or tree navigation: no user invocation of a procedure skill followed by its procedure-spec message and a state message means inert; otherwise engaged with that state.
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
