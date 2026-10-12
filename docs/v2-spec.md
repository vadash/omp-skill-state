# V2 spec: general task fit and the cache ceiling

Source: design session of 2026-10-12 (grill transcript, paper arXiv 2608.26263v2, runs A–F in `docs/verification.md`, harness cache internals of the read-only checkout). Decisions are recorded in ADR 0002 and ADR 0003 and the glossary; this spec is the ticket-ready synthesis. Section references to `docs/spec.md` describe the code as it is today.

## Problem Statement

The runtime executes a narrow class of procedures well: tasks whose every step needs exactly one tool result of memory and whose state fits a handful of keys. Real tasks leak out of that shape in four ways:

1. **One-step memory.** The projection pins only the last tool pair, so the agent re-reads the same file or issue across consecutive steps (observed repeatedly in the two 2026-10-12 runs: `index.ts` re-read three times because earlier reads left the prompt).
2. **Fragile idle exit.** A run disengages after a few state-unchanged steps; run E fired on a legitimate read preamble at step 4, and the bundled skill already had to raise its threshold to compensate.
3. **Fragile patch channel.** The fenced block arrives one step late (the rules are absent from the first prompt), so every procedure skill must restate the fence format and a skill that forgets silently loses its first patch. Freehand JSON is also the paper's measured small-model failure mode (~12% malformed).
4. **Unbounded state.** Nothing checks state growth; run F's `findings` log pushed the state, and with it the prompt, steadily upward.

On the cost side, the cache ceiling sits too low: the execution state changes nearly every step, so of each step's prompt only the part through the procedure spec is byte-stable across steps. Everything after — the state and the observation, roughly a third of a procedure step — is re-billed every step. On Anthropic-shaped providers the ceiling is worse in practice: with no per-call message the harness places only trailing cache anchors, which go stale the next step, so even the rules and the spec re-bill.

## Solution

Four generalities: a configurable observation window (pin the last K tool pairs, not one), an idle path that warns before it disengages, operating rules delivered from the first step (skills stop teaching the patch format), and a soft state-size cap that nudges consolidation.

One channel change: the state patch moves onto a strict, zero-approval extension tool (`state_update`), registered at engage, present from the first step. The fenced block and its parser are deleted, not kept as a fallback. JSON repair is rejected: silent repair can corrupt the only record of the past, where the block-and-retry path reports exact errors.

One cache change: the head's single state message splits into a stable *state core* and a volatile *scratch state* (keys named `volatile` in the schema). The projection returns the scratch message as a deliberately per-call copy, which is what makes the harness anchor its durable cache breakpoint on the newest stable message before it — the last core message. The ceiling rises from through-the-spec to through-the-core.

## User Stories

### Generality

1. As a long-task user, I want the runtime to pin the last several tool pairs as the observation, so that consecutive steps over the same file or issue do not force re-reads.
2. As a long-task user, I want the observation window configurable per skill, so that read-heavy procedures can pay context for memory and tight procedures stay lean.
3. As a long-task user, I want a shared byte cap across the whole observation window, so that a wider window cannot balloon a step's prompt without bound.
4. As a long-task user, I want the runtime to warn before it disengages for idleness, so that a legitimate quiet stretch does not silently end my procedure.
5. As a long-task user, I want a higher default idle threshold, so that exploration-heavy tasks are not cut short by quiet reading steps.
6. As a long-task user, I want the runtime to nudge the model when the execution state grows past a soft cap, so that long runs do not let the state bloat every later prompt.
7. As a long-task user, I want the model to see the operating rules from the very first step, so that the run starts with correct patches instead of a bootstrap guess.
8. As a long-task user, I want ordinary sessions that never engage a procedure to carry none of this — no extra tool definition, no nudges, no head — so that the runtime costs nothing when inactive.

### The agent inside a procedure

9. As the agent executing a procedure, I want to update the execution state through a tool call, so that my patch cannot be mangled by prose formatting around a fenced block.
10. As the agent, I want the state-update tool available from the first step, so that I never operate under rules I have not been given.
11. As the agent, I want an invalid patch to block the whole batch with the exact validation error, so that I can fix precisely what was wrong without partial execution.
12. As the agent, I want a recent window of tool results visible each step, so that I can relate what I just read to what I do next.
13. As the agent, I want a nudge when my state is one quiet step from idle disengage, so that I can record a meaningful fact instead of being cut off.
14. As the agent, I want a nudge when the state exceeds its size cap, so that I can consolidate superseded findings instead of growing the prompt forever.
15. As the agent, I want the stable part of the state to stay byte-identical while I work, so that my per-step prompt is mostly cache hits and cheap.
16. As the agent, I want to end a procedure by replying without tool calls after a final consolidating patch, so that the ending rule stays simple and the last state is complete.
17. As the agent, I want a state-update call after disengage to fail gracefully as a tool error, so that a stale call never corrupts an ordinary session.

### Procedure-skill authors

18. As a procedure-skill author, I want the runtime to deliver the operating rules on the first step, so that my skill text does not have to teach the patch format at all.
19. As a procedure-skill author, I want to declare which state keys are scratch, so that the stable part of my state stays cacheable while working keys churn.
20. As a procedure-skill author, I want new state keys I did not anticipate to land in scratch by default, so that an unplanned key cannot destabilize the cached prefix.
21. As a procedure-skill author, I want window, idle threshold, retries, observation cap and state cap settable per skill in the schema, so that the runtime fits my procedure's shape without code.
22. As a procedure-skill author, I want state updates to require no user approval, so that procedures do not nag through every step.

### Maintainers

23. As a maintainer, I want the fence parser and its grammar deleted, so that there is exactly one patch channel to test and document.
24. As a maintainer, I want the cache geometry decided in the projection and pinned by unit tests, so that provider-facing cache behavior is not discovered only in live runs.
25. As a maintainer, I want the scratch copy's distinguishing field verified never to reach the wire, so that the per-call marking cannot leak into model-visible content.
26. As a maintainer, I want the channel and split decisions in ADRs and the glossary, so that nobody re-introduces the fence or a single state message later.
27. As a maintainer, I want a real-session verification run with cache figures after the change, so that the through-core ceiling is measured, not assumed.
28. As a maintainer, I want the runtime to keep validating patches before any tool executes, so that all-or-nothing survives the channel change.

## Implementation Decisions

### Patch channel (ADR 0002)

- The patch travels as an extension tool, `state_update`, registered through the harness's public `registerTool` — no MCP server, no harness edits. Its single parameter is a wrapper object with one `patch` value (the whole Δt), which keeps the definition compatible with strict grammars that require fully declared properties; contents are still validated against the state schema.
- `strict: true` on the definition; the harness's sticky per-provider fallback handles providers that reject strict grammars.
- Zero approval via the definition-level decision `{ tier: "read", policy: "allow" }` — a bare `read` tier still prompts in always-ask modes. A user's explicit per-tool deny still wins.
- Registered at engage (mid-session registration is flushed before the handler completes), so the channel exists from the first procedure step. Only procedure sessions ever see the definition. There is no unregister in the API: after disengage the definition stays registered for the session's remainder and `execute` returns a graceful "no active procedure" error. Deactivation via the active-tools list is deliberately not used — Anthropic replays retired definitions as prompt anyway.
- The tool's execute signature is `(toolCallId, params, signal, onUpdate, ctx)` — signal before onUpdate (the order commonly published is wrong).
- All-or-nothing is preserved end to end: the `assistant_message` handler scans the reply's tool-call blocks, validates the patch, and on failure sets the pending error that makes the existing `tool_call` blocking path refuse the entire batch — including the `state_update` call itself. A valid patch is applied in the tool's execute, which cannot run while blocked. Retry counting, block-and-re-prompt and the degrade exit are unchanged.
- The finish protocol is unchanged: a reply with no tool call still ends the run and carries the final state. Skills teach one final consolidating `state_update` before that reply.
- No JSON-repair dependency. Tool arguments are protocol-level JSON, so the fence's failure class does not exist on this channel; a repair layer would silently produce different state than the model meant, where the block-retry-degrade path reports exact errors. The one plausible quirk — a model double-encoding the patch as a JSON string — is handled by a three-line string coercion in execute, added only if a run shows it happening.
- The fenced block channel is deleted outright: parser, fence grammar, and their tests. Rules text and skill text retarget to the tool. Dual channels were rejected: they force a precedence rule into every doc and test surface for a failure class the tool cannot produce.

### Generality

- Observation window: a per-skill parameter (default 1) pins the last K tool pairs as the observation. The backward walk stops at the first unpairable pair, and one shared byte cap covers the whole window; the cap's largest-result truncation and marker rules are unchanged.
- Idle: default threshold raised to 5 consecutive state-unchanged steps. At threshold−1 the runtime injects a turn-scoped developer nudge ("state unchanged; disengage at N+1") so the model can act; the disengage itself is unchanged. Turn-scoped messages never pollute stored history and sit behind the cache breakpoint.
- First-step rules: at engage, the operating rules are delivered for the first step via the before-agent-start surface as a synthesized message — per-call by construction, and step 1 is cold anyway. From step 2 on, the stored rules message serves. Skills no longer restate the patch format.
- State size: a per-skill soft cap. Over cap, a turn-scoped developer nudge asks the model to consolidate (drop superseded findings). Nothing is blocked; the cap is a signal, not a limit.

### Cache ceiling (ADR 0003)

- The head grows to four stored messages, in order: operating rules, procedure spec, state core, scratch state. The scratch sits last so the per-call mark anchors the durable breakpoint on the newest stable message before it — the last core message.
- The split is schema-driven: an `x-state.volatile` list in `state.schema.json` names the scratch keys; every other declared key, and any undeclared new key, lands in scratch. An empty core renders as an empty object — the message must exist for the head to be complete.
- The projection returns the scratch message as a deliberately differing copy (a distinguishing field the harness's deep-equality marking will catch), so the harness marks it per-call. The distinguishing field must live outside model-visible content; a unit test pins the copy's shape and the field's location.
- Effect: on prefix-caching providers the cached ceiling rises from through-the-spec to through-the-core. On Anthropic-shaped providers the deliberate mark is also what makes the sub-prefix anchor placement deterministic — without any per-call mark the planner places only trailing anchors, which go stale each step.
- Re-derive, compaction (both state messages carried in the summary and preserve-data) and the transcript renderer handle both messages; a branch holding a procedure invocation but not both state messages is an incomplete head and stays inert.
- Merge semantics are untouched: set, null-delete, arrays whole.

### Docs

- Decisions recorded now: ADR 0002 (channel), ADR 0003 (split + marking), glossary terms (state core, scratch state, observation window, cache ceiling, per-call message), this spec.
- Behavior docs ride with the implementation tickets: `docs/spec.md` sections 7–9, 11, 15, 16 and the bundled skill's text and schema are updated in the same changes that change the behavior, so the spec never describes a runtime that does not exist.

## Testing Decisions

A good test here asserts external behavior at a module interface: plain message arrays or reply records in, projected arrays or policy outcomes out. No test pokes internal fields — the existing suites establish that style, and one existing test already pins a rules↔parser agreement that this change retires with the parser.

Seams — all four exist today; no new seam is introduced:

1. **Projection interface** (highest seam for cache geometry): window walk and its stop-at-first-unpairable rule; the four-message head order; cap across the whole window; the per-call precondition — the returned scratch copy is structurally unequal to its stored counterpart while its model-visible content is equal; non-mutation of input.
2. **Step-policy interface**: patch outcomes from tool-call block scans (valid, invalid, none, final), idle counting with the nudge threshold, retry counting and degrade, state-cap signal, final-state taken-once semantics.
3. **Adapter through the fake session** (the existing second adapter — the real seam): registration happens at engage and only there; first-step rules delivery; nudges issued as turn-scoped sends at the right thresholds; the captured tool definition invoked directly through its public execute contract, including apply-when-valid and graceful no-procedure failure; block-all on an invalid patch; disengage and re-derive with a two-message head across switch, rewind, tree and compaction.
4. **State interface**: new parameters and their defaults, `volatile` list loading and validation, key-placement helper (core vs scratch), merge untouched.

Explicitly not unit-testable and covered elsewhere: that the harness marks the differing copy per-call and anchors the breakpoint after the core is harness-internal behavior. The unit suite pins the precondition (the copy differs, in a field outside model-visible content); the consequence is measured in a real-session verification run with cache figures — the same harness-contract class the existing verification doc was built for, and the reason it exists.

Prior art: the per-module suites and the fake-session lifecycle tests; the verification harness with its analyzer for run-level figures.

## Out of Scope

- Subagent propagation and per-subagent procedures (unchanged: subagents stay inert).
- Model-invoked engagement; procedures still start only from a user skill invocation.
- Multiple concurrent procedures per session; retrieval or summarization of dropped history.
- Changing merge semantics (arrays remain set-whole); per-key array append modes.
- MCP, harness source edits, and provider-side strict-grammar work.
- JSON repair in any form; `setActiveTools` registration gymnastics.
- Hard enforcement of the state cap (nudge only, by decision).

## Further Notes

- ADR 0002 supersedes the deferral recorded in `docs/spec.md` section 8 ("the tool is added only if a measured failure rate justifies it"): the tool is the only channel from v2.
- The two 2026-10-12 session runs are the behavioral baseline for the window change: both completed the task but re-read the same files across steps because of the one-pair pin.
- The cache baseline to beat is run F: median prompt 11,348 tokens, uncached median 788, cache read positive on 49 of 51 steps — a ceiling of roughly through-the-spec. The verification run after this change should show the uncached share drop to observation-plus-scratch while the core stays cached.
- Ticket split is deliberate follow-up work by the maintainer; the natural seams are the four sections above (channel, generality, split, docs/verification), with the channel first since the skill text and rules rewrites depend on it.
