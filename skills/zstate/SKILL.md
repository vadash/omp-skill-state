---
name: zstate
disable-model-invocation: true
description: "Engage the skill-state runtime for the task given in the same invocation. While it runs, every model call sees the skill text, the execution state and a bounded tail of the most recent conversation under a prompt budget, never the growing transcript; the model records what matters in the state each step, so a long task keeps a bounded prompt and carries no stale facts. Invoke it first and give the task in the same prompt, for example /skill:zstate <task>."
---

# Zstate: skill-state mode

This skill defines no task. It engages the skill-state runtime and tells you how to work inside it.

The task is the `User:` line at the end of this prompt. In your first `state_update` call, copy it verbatim into `goal`, set `working_dir`, and set `next_step` to your first action. If there is no `User:` line, there is no task: say so and stop.

Past conversation is mostly hidden from you while this runs: your prompt carries the execution state plus the tail, the most recent stored messages behind the state core, under a prompt budget; older messages leave the prompt as the tail evicts them. The state is the only durable record, so commit anything that must outlive the tail in the same step that observed it.

Anything the task names, you read once and keep in the state: another skill through `read skill://<name>`, a file, an issue. Copy the requirements that bind this run into `constraints`, phrased so they stand alone.

Loop:

1. Read the state. `plan` holds the remaining actions in order; its front is the next one.
2. Set `next_step` to the single action this step performs.
3. Do that action.
4. Record the outcome: facts into `findings`, new requirements into `constraints`, what you still do not know into `open_questions`, and the remaining actions into `plan`. One string per item, phrased to stand alone. A stable discovered fact that later steps only read — a version, a build command, a port, a route, an environment layout — goes into `knowledge` instead, one member per fact, named so the fact stands alone: `{"knowledge": {"db_port": 5432}}`. `knowledge` merges key-wise and rides in the state core, so writing one member never re-sends the others and the cached prefix holds.
5. Return to step 1.

Drop findings that later facts supersede: the state holds what is true now, not a log of what you did.

Set `next_step` to the action this step performs, even on a step that only reads.

Finish when the task is done: make one last patch that consolidates everything the result needs, then end; give the result from the state alone. If a fact is not in the state, you do not know it.

Field meanings:

- `goal`: the task, copied verbatim from the `User:` line. Never rewritten.
- `working_dir`: the directory every path is relative to. Set once.
- `constraints`: what binds the work: requirements from the task and from anything it names.
- `plan`: the remaining actions, in order. Done actions are removed, not kept.
- `findings`: established facts only. No plans, no speculation.
- `open_questions`: what you still do not know to finish the task. Ordered; pop from the front.
- `next_step`: the one action the current step performs. Overwritten every step.
- `knowledge`: stable discovered facts, one member per fact. Members stay until a later fact supersedes them; a `null` member deletes one.

A task may need keys the schema does not name. Add them; the fields above stay. Keep anything that changes on most steps out of the core: a growing list belongs in a volatile array key (`findings`), while a list that has frozen into stable reference — the routes of a finished recon — is worth declaring in the schema as an ordinary array key left off the `volatile` list, so once frozen it caches in the core beside `knowledge`.
