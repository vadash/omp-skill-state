# Compaction as state projection

While a procedure is engaged the prompt is bounded, but omp's auto-compaction still fires, because it floors its decision on a local token count of the *stored* transcript rather than on provider-reported usage — deliberately, so that a payload-shrinking transform can never suppress it. We therefore had to decide how the runtime relates to compaction. We chose to have the runtime *become* the compactor: it registers a `session_before_compact` handler lazily, on the first engage, and returns a compaction whose summary is the rendered execution state and whose `firstKeptEntryId` is taken from the harness's own `preparation`. This costs no summarizer call, and when the procedure ends the session resumes from a history whose summary is the final state, so the hand-back is lossless. The trade-off is that registering that handler switches off speculative (background, pre-threshold) compaction for the rest of the session — omp disables speculation whenever any `session_before_compact` handler exists, since a speculated result would bypass the handler's veto — and there is no way to unregister, because `pi.on` has no counterpart. Lazily registering confines that cost to sessions that actually ran a procedure.

## Considered options

- **Let compaction run as normal.** Costs one summarizer call per threshold crossing to produce text the projection then discards.
- **Register the veto at load.** Taxes every session that installs the plugin, including sessions that never run a procedure.
- **Register lazily and veto while engaged** (chosen).

## Consequences

Speculative compaction is unavailable from the first engage until the end of that session. Blocking compaction still works, so context overflow remains protected.

## Amendment: the cut is the current step

The integration run (`docs/verification.md`) showed that `firstKeptEntryId` cannot be taken from `preparation`. The harness proposes a turn-sized kept tail; a procedure is one user turn, so the proposal keeps most of the run, and the harness's post-compaction headroom check then fails. Its dead-end rescue runs `shake("elide")`, which rewrites the kept entries in place on disk — tool results and any fenced or XML block of 400+ tokens, custom messages included — so the stored state messages and the current observation became placeholders and the model lost `t`. The handler now cuts at the latest assistant message on the branch (the current step), which leaves the rescue nothing to do, and the state message is rendered as plain JSON without a fence so no shake path can target it. Spec section 10 carries the detail.
