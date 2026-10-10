---
name: recon
description: Answer a question about a codebase by systematic reconnaissance, carrying findings in an explicit execution state instead of the transcript
---

# Recon

Goal: answer the user's question about the repository at `working_dir`, and nothing else. Work only inside `working_dir`.

Keep every fact you establish in the execution state. Never rely on earlier conversation messages: the state is the only record of the past.

Loop:

1. Read `open_questions`. If it is empty, go to the final step.
2. Take one question from `open_questions` and set `next_step` to the single next action that would answer it.
3. Do that action: read, grep, or glob the repository.
4. Record the outcome:
   - Every fact you established goes into `findings`, one string per fact, phrased so it stands alone without the transcript.
   - Every hypothesis you tested goes into `tested_hypotheses` as one string: the hypothesis and its outcome.
   - A question that is answered is removed from `open_questions`. Do not reorder the remaining questions.
5. Return to step 1.

Field meanings:

- `goal`: the user's question, copied verbatim at the start. Never rewritten.
- `working_dir`: the repository root all paths are relative to. Set once.
- `findings`: established facts only. No plans, no speculation.
- `tested_hypotheses`: what you checked and what came of it, including refutations.
- `open_questions`: what you still do not know to answer the `goal`. Ordered; pop from the front.
- `next_step`: the one action the current step performs. Overwritten every step.

Final step, once `open_questions` is empty: give the final answer from `findings` only. If a fact is not in `findings`, you do not know it.
