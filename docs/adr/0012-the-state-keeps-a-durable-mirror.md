# The state keeps its stored messages and gains a durable mirror

The projection's source for the execution state must be a stored message returned byte-unchanged, or the harness marks it per-call and the cache ceiling falls back to the system prompt and tools (ADR 0011). But a stored message is not a durable record: the harness's `shake("elide")` rescue rewrites eligible custom messages in place, persisted to disk (ADR 0001 amendment), so the only copy of the past is rewritable by a pass the runtime does not control.

We keep both copies. The state core and the scratch state stay stored custom messages — they are what anchors the cache and what the projection reads — and every commit is mirrored through `pi.appendEntry`, an entry the harness never sends to the LLM, carrying the same partitions and the same write stamp as the messages it mirrors. Re-derive reads the mirror; a stored state message whose content disagrees with the newest mirror is repaired by re-sending the head. Compaction keeps cutting at the current step, which is what keeps the rescue from firing in the normal case.

## Considered options

- **`appendEntry` as the projection's only source**: rejected — a synthesized message has no stored counterpart, so it is per-call, the breakpoint falls back to the system prompt and tools, and the whole head re-bills every step.
- **Stored messages only** (today): rejected — one rewritable copy of the only record of the past, on a path an integration run already measured losing it.
- **Stop owning compaction** and let the harness summarize: rejected — auto-compaction fires on the stored transcript, which the projection hides anyway, so it would buy repeated summarizer calls over material no one sends, and the harness's own cut would then decide what the tail can still see.
- **Rejecting or cancelling the parked next-turn send** (the `beta` branch's ADR 0008 defence): not available — no such harness API exists — so the mirror is the durable half and the send guards are not needed.

## Consequences

- Two copies of the state with one writer: `stateMessages` builds both, so they cannot disagree at build time; they disagree only after an external rewrite, which is what the repair path detects.
- The mirror is read by re-derive and by the repair check; the projection keeps reading the messages.
- Adopted from the abandoned `beta` branch: state reads order by write stamp with branch position as the final tiebreak (its ADR 0008), because a parked next-turn send can land after a newer commit and time-travel the projection. The mirror carries the stamp, so the ordering survives the move.
- Verified: `appendEntry` writes a `CustomEntry { type: "custom", customType, data }` (`src/session/session-manager.ts:3521-3525`, `src/session/session-entries.ts:180-184`) that `getEntries()`/`getBranch()` return like any other entry, and the harness documents it as the reload-state mechanism (`src/extensibility/extensions/types.ts:539-551`, `:1602-1603`).
