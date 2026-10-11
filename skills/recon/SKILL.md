---
name: recon
description: "Engage the skill-state runtime for the task given in the same invocation. While it runs, every model call sees only the skill text, the execution state and the current step's observation, never the growing transcript; the model rewrites the state each step, so a long task keeps a fixed prompt size and carries no stale facts. Invoke it first and give the task in the same prompt, for example /skill:recon <task>."
---

# Recon: skill-state mode

This skill defines no task. It engages the skill-state runtime and tells you how to work inside it.

The task is the `User:` line at the end of this prompt. In your first state block, copy it verbatim into `goal` and set `working_dir`. If there is no `User:` line, there is no task: say so and stop.

Past conversation is hidden from you while this runs. The execution state is the only record of the past; the runtime's operating rules say how to edit it. A tool result is one step's observation and is gone from the next prompt, so anything that must outlive the step goes into the state in that same step.

Anything the task names, you read once and keep in the state: another skill through `read skill://<name>`, a file, an issue. Copy the requirements that bind this run into `constraints`, phrased so they stand alone.

Loop:

1. Read the state. `plan` holds the remaining actions in order; its front is the next one.
2. Set `next_step` to the single action this step performs.
3. Do that action.
4. Record the outcome: facts into `findings`, new requirements into `constraints`, what you still do not know into `open_questions`, and the remaining actions into `plan`. One string per item, phrased to stand alone.
5. Return to step 1.

Finish when the task is done: reply with no tool call and give the result from the state alone. If a fact is not in the state, you do not know it.

Keep the state current. Steps that leave it unchanged count as idle, and an idle run disengages the runtime and returns the session to ordinary execution.

Field meanings:

- `goal`: the task, copied verbatim from the `User:` line. Never rewritten.
- `working_dir`: the directory every path is relative to. Set once.
- `constraints`: what binds the work: requirements from the task and from anything it names.
- `plan`: the remaining actions, in order. Done actions are removed, not kept.
- `findings`: established facts only. No plans, no speculation.
- `open_questions`: what you still do not know to finish the task. Ordered; pop from the front.
- `next_step`: the one action the current step performs. Overwritten every step.

A task may need keys the schema does not name. Add them; the fields above stay.
