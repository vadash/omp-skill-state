# Skill State

A runtime for omp that executes a procedural skill against an explicit execution state instead of a growing conversation. It exists because prompt size and stale facts both grow with execution length in ordinary history-based runtimes.

## Language

**Procedure**:
A single run of a skill under the skill-state runtime. The procedure starts when the user invokes its skill and ends when the runtime disengages.
_Avoid_: task, job, workflow, session

**Procedure skill**:
A skill that declares a state schema. Only these can start a procedure.
_Avoid_: stateful skill, state skill

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

**Observation**:
The environment output for the current step, `Oₜ`. It is the only past-free material the model receives besides the spec and the state.
_Avoid_: result, output, feedback

**Step**:
One provider call. A step produces at most one state patch, one batch of tool calls, and one set of observations.
_Avoid_: turn, iteration, round

**Projection**:
The per-step rewrite that replaces the message list sent to the model with the triple spec, state, observation. The stored transcript is never changed by it.
_Avoid_: compaction, truncation, filtering

**Head**:
The three stored custom messages the projection pins at the front of every prompt: the operating rules, the procedure spec and the latest state. Sent at engage and again after every compaction, byte-equal, so the provider's prefix cache holds across the cut.
_Avoid_: preamble, prefix, context

**Cut**:
The compaction's first kept entry. While engaged it is the current step, the latest assistant message on the branch, not the turn-sized tail the harness proposes.
_Avoid_: boundary, checkpoint, kept tail

**Final state**:
The state accepted from a reply with no tool call, which ends the run. It is stored as a next-turn message once the session is idle, not as an aside.
_Avoid_: result, answer, summary

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
