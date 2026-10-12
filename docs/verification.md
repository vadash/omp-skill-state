# Verification: one long real session

Real-session acceptance evidence for the shipped runtime. Run G exercises the tool channel, the observation window, the nudges and the split head in one long procedure; a probe session covers the two per-call nudges, which an ordinary procedure cannot show. The cache baseline to beat was run F (median prompt 11,348 tokens, uncached median 788, `cacheRead > 0` on 49 of 51 steps — a through-the-spec ceiling); runs A–F and their findings are preserved in git history.

## Setup

- omp 18.10.2, interactive TUI in a pseudo-terminal, driven by typed input. The plugin is linked (`omp plugin link`), so the live code is this checkout.
- Launch: `SKILL_STATE_CAPTURE_DIR=verification/sessions/capture-g omp --session-dir verification/sessions --config verification/compact-early.yml --model glm-5.3-flash --thinking low`. The config sets `compaction.thresholdPercent: 10`; this omp cuts at 10 % of the 300 K window, ≈ 30 K tokens. The post-resume leg ran without the variable, so steps 57–59 have no captured bodies.
- Model: `zcode0/glm-5.3-flash`.
- Procedure: `/skill:zstate` with the task to report the H1 title of each of the first 50 markdown files in the harness checkout's `docs/` (82 files), case-insensitive filename order, one finding per file, formatted `<filename>: <H1>`. Constraints in the invocation: the first action is one `task` subagent call that lists the files, the list is recorded into the state in the step it arrives, then exactly one file per step read with the selector `:1-5`.
- Evidence: `bun verification/analyze.ts <session.jsonl> [--titles <dir> <n>]` reads the stored transcript and prints the step timeline, token statistics over the projected steps, the compaction entries, the last stored state, the subagent transcripts and a check of the findings against the real H1 titles. The session files stay out of git (`verification/sessions/` is ignored); the ids below locate them.
- Request capture: the `verification/capture/` plugin — linked once (`omp plugin link verification/capture`), dormant unless `SKILL_STATE_CAPTURE_DIR` is set — appends every provider request body to `verification/sessions/capture-<run>/requests.jsonl`. Run G wrote 59 requests there, the probe 20; both corpora are how a run proves what never reaches the wire.

Projected step: an assistant message produced while a state head message is on the branch. Prompt tokens: `input + cacheRead + cacheWrite` of that message's usage.

## Runs

| Run | Session | Steps (projected) | State messages | Compactions (by runtime) | Prompt tokens per step, median / max | Steps with cacheRead > 0 | Correct findings | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G | `01a13194` | 56 (55) +3 | 124 | 7 (7) | 14211 / 17232 | 57/58 | 50/50 | acceptance run |

## Acceptance, run G

Flat input: 58 projected steps, 55 in the procedure and 3 after the resume. Prompt tokens per step min 11349, median 14211, p90 14527, max 17232 (max/median 1.21): the prompt stays flat while the state turns over. `cacheRead > 0` on 57 of 58 steps and ≥ 50 % of the prompt on 55; the misses are the three head-change or cold steps — 2 (the engage, head freshly sent), 4 (the state core fills from empty to `goal`, `working_dir`, `constraints`: the cache ceiling ends at the first head message the step changed) and 57 (first call after the resume, cold in a fresh process). From step 7 through step 54, and again on 56, `cacheRead` pins at 10496 — system prompt, tools, rules, procedure spec, state core, byte-equal on every patched step — while the scratch state churns underneath: rendered 4.6–4.7 KB through the run, `plan` popping from the front every step, `file_list` added mid-run as an undeclared key. That is the through-core ceiling of ADR 0003, and the case the split was for: under run F's single state message a front-pop of `plan` re-bills the whole state every step; here it re-bills only the scratch. Uncached input per step min 368, median 3778, max 16592 (the max is the core-transition step 4); the uncached remainder is the per-call scratch copy, the observation window (three tool pairs) and the user turn — a 17.5 KB median tail against the 3778-token median, ≈ 4.7 bytes per token on JSON-heavy text. On consolidation step 55 the provider matched 2688 tokens past the core (`cacheRead` 13184): the scratch head was byte-stable there.

Compaction: 7 entries, all `fromExtension: true`, each with the summary `Execution state of procedure "zstate" (skill-state runtime):` followed by the state as plain JSON and `preserveData` carrying both partitions; `tokensBefore → tokensAfter` 31589 → 11178, 31237 → 11240, 31280 → 11081, 31042 → 11043, 30844 → 11159, 30537 → 11087, 30639 → 10982. No summarizer call appears in the transcript (the `model_usage` entries are the harness's own unexpected-stop judge on the free `bf0` model). 0 entries rewritten by a rescue pass.

Final state: 50 findings, `open_questions` empty, 50/50 titles match the files. The model added `file_list`, an undeclared key; the split sent it to the scratch state and the core kept only `goal`, `working_dir`, `constraints`. The final reply is step 56; the state messages are entries 423–424, stored 2 s later by the idle poll. One invalid patch occurred and was refused (`next_step: null` → `state key "next_step" must be a string`); the model corrected it next step.

`/resume`: quit the TUI and relaunched with `--continue`. The runtime re-derived the procedure from the branch and re-registered the tool; the stored head served again — a re-derive never re-sends it. The probe `Continue the procedure from the execution state: state the last finding` ran projected in three steps: the reply came from the state alone (`plugin-manager-installer-plumbing.md: Plugin manager and installer plumbing`, step 57 — the cold miss, in=11412 with `cacheRead` 0), a follow-up patch landed on 58, and the closing step 59 ran 368 uncached tokens against `cacheRead` 11328.

Subagent: the `task` call spawned `DocsMdListing` (scout). Its transcript holds 2 assistant messages and 2 tool calls and no skill-state message; it ran under ordinary context and returned its list to the parent as a normal tool result.

Payload capture: the capture corpus holds 59 request bodies — the 57 main-session requests up to the quit (56 procedure steps plus one provider retry) and the listing subagent's 2, which ran unprojected with no head; the post-resume leg is uncovered (no capture variable on the relaunched process). The scratch copy's per-call mark (`details.perCall`, ADR 0003) appears in none of the 59 — 0 occurrences. The probe corpus below agrees (0 of 20).

## Probe: the per-call nudges (`01a13184`)

A separate short session, same launch line and capture, exercised both nudges, which an ordinary procedure cannot show: the idle warning needs `idleSteps − 1` consecutive unchanged steps and the consolidation ask needs a state over its `stateBytes` cap.

Idle: a small `zstate` task engaged and completed; six reply-only prompts then drove the idle counter to 6 (`idleSteps` is 7 for the bundled skill), and the next request carried the idle nudge verbatim — `The execution state has been unchanged for 6 consecutive steps. One more step without a state_update patch that changes the state disengages this procedure ...` — appended to the projected prompt only. The runtime counted that step patch-less and disengaged at the threshold, exactly where `nudgePending` aims the warning (the step that would disengage); the `state_update` attempt riding the same reply was refused with `no active procedure`. The head messages stay on the branch after a disengage, so the following steps still read as projected in the transcript.

Cap: re-engaged in the same session, the model recorded a 46 KB file verbatim as one finding; the rendered scratch alone measured 47169 bytes — 47558 with the core, the policy's summed measurement — against the 16384-byte cap, and the next request carried the consolidation ask once (`capNudged` latches per over-cap episode). The model consolidated in that same step — rendered partitions 47558 → 969 bytes, the blob replaced by a provenance summary — and no ask reappeared while the state measured back under the cap. The same probe fired the observation byte cap for real: the first read of the 46 KB file was cut at 32768 bytes with a re-read marker, and the model read the remainder before recording.

## Not covered

- The degrade path (three invalid patches) did not occur; the single-block case did (run G) and the rest rests on the unit tests.
- A rewind and the inert cases (a skill without a schema, a model-initiated `read skill://…`) rest on the unit tests; that speculative compaction is off once the handler is registered is the harness's own behaviour and was not observed directly.
- With `xd:// Tools` enabled (this harness's default), registered tools are not shipped as top-level schemas: the model discovers `state_update` from the mount notice and drives it with the write tool over `xd://state_update`. Every patch step of run G and the probe rode that shape, and commits, the schema refusal and the cap ask all behaved normally over it — but at the probe's nudged step the runtime counted the step patch-less and disengaged before the mount's forwarded call landed, so the model's comply-with-the-nudge patch was lost. Worth a look if a procedure ever disengages with a patch seemingly in flight; the tool channel's own contract rests on the unit tests and these runs.
- One model and one provider. Cache figures are what `zai` reports for `glm-5.3-flash`.
