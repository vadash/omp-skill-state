---
name: zstate
disable-model-invocation: true
description: "Engage the skill-state runtime for the task given in the same invocation. While it runs, every model call sees only the skill text, the execution state and the current step's observation, never the growing transcript; the model rewrites the state each step, so a long task keeps a fixed prompt size and carries no stale facts. Invoke it first and give the task in the same prompt, for example /skill:zstate <task>."
---

# Zstate: skill-state mode

This skill defines no task. It engages the skill-state runtime and tells you how to work inside it.

The task is the `User:` line at the end of this prompt. In your first state block, copy it verbatim into `goal`, set `working_dir`, and set `next_step` to your first action. If there is no `User:` line, there is no task: say so and stop.

A state block is a fenced code block. Its opening line is ` ```json state ` — the label word `state` after `json` is required — and its closing line is ` ``` `. A plain ` ```json ` fence is not a patch: the runtime ignores it silently. The runtime's operating rules reach you one step late, so this paragraph is the format for the first block; the rules repeat it from the next step.

Past conversation is hidden from you while this runs. The execution state is the only record of the past; the runtime's operating rules say how to edit it. A tool result is one step's observation and is gone from the next prompt, so anything that must outlive the step goes into the state in that same step.

Anything the task names, you read once and keep in the state: another skill through `read skill://<name>`, a file, an issue. Copy the requirements that bind this run into `constraints`, phrased so they stand alone.

Loop:

1. Read the state. `plan` holds the remaining actions in order; its front is the next one.
2. Set `next_step` to the single action this step performs.
3. Do that action.
4. Record the outcome: facts into `findings`, new requirements into `constraints`, what you still do not know into `open_questions`, and the remaining actions into `plan`. One string per item, phrased to stand alone.
5. Return to step 1.

The patch merges into the state: a non-null value sets its key, `null` deletes it, a key you omit is kept. Arrays are set whole, never merged: to add one item, resend the complete array, so resend an array only when it changed. Drop findings that later facts supersede: the state holds what is true now, not a log of what you did.

Finish when the task is done: reply with no tool call and give the result from the state alone. If a fact is not in the state, you do not know it.

Every reply carries a state block, even a step that only reads: set `next_step` to the action this step performs. Steps that leave the state unchanged count as idle, and an idle run disengages the runtime and returns the session to ordinary execution.

Field meanings:

- `goal`: the task, copied verbatim from the `User:` line. Never rewritten.
- `working_dir`: the directory every path is relative to. Set once.
- `constraints`: what binds the work: requirements from the task and from anything it names.
- `plan`: the remaining actions, in order. Done actions are removed, not kept.
- `findings`: established facts only. No plans, no speculation.
- `open_questions`: what you still do not know to finish the task. Ordered; pop from the front.
- `next_step`: the one action the current step performs. Overwritten every step.

A task may need keys the schema does not name. Add them; the fields above stay.
