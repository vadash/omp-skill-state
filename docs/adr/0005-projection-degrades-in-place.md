# The projection degrades in place instead of falling back to ordinary history

A real run's batch carried an invalid patch beside a read. The fold refused the step and the `tool_call` hook blocked every call, so the assistant message's calls never produced results and the projection's newest pair became unpairable. The projection failed, the step prompt returned nothing, and the context hook passed the raw transcript: four consecutive turns at 29K–32K input tokens, cache reads at 640, reasoning traces from twenty steps back re-entering the prompt — the sufficiency-statistic invariant broken by a tool-pairing glitch. We change the contract: while the head is intact, the projection never returns ordinary history. On unpairable window material it projects the head and a per-call degradation notice naming the gap — the walk collects pairs newest first, so nothing survives an unbuildable newest pair and the degraded window is empty; a bounded step. A missing head still falls back: there is nothing to project (spec §14).

## Considered options

- **Synthesize tool results for blocked calls so the batch stays pairable.** Treats one cause at the block path, needs a new harness register row for how block reasons reach context, and cannot cover unpairability from other causes.
- **Keep the fallback, improve the rejection error.** The rider rejection alone was never the damage — run G shows a rejected patch blocks and the retry recovers; the fallback's blast radius is the defect.

## Consequences

The degradation notice rides every degraded step and re-arms on the first projected step — inverted from the fallback notice's once-latch, because a fallbacked model could see history while a degraded model sees only the head and cannot know why its window is empty. A degraded step is policy-neutral: the fold already consumed the batch's retry, and the idle counter measures the model stopping state edits, not runtime glitches. Spec §7's window invariant becomes "newest pair or degradation notice"; pair tags, the window notice and the cap's floor apply only when a window exists.

Amended by ADR 0010: the window walk and its pair-pairing rule are deleted. A step is degraded when the head is intact and the tail is empty, which narrows the trigger but not the contract — the projection still never returns ordinary history while the head exists.
