# Verification: run H over the shipped tool channel

Real-session acceptance evidence. Both recorded runs are evidence for the pre-redesign runtime: they predate the universal redesign (ADR 0010-0012), and run H exercised the observation window the tail has since replaced, plus the old idle nudge whose wording said it would disengage (quoted in the run H section below). Run H exercises the top-level `state_update` tool, the observation window, the nudges and the split head in one procedure; a print-mode probe establishes why the run is driven through the TUI. Run G is kept as the measured baseline the new channel is compared against.

## Setup

Since ticket #28 every driven run uses an isolated sandbox profile, never a live profile:

- `PI_CONFIG_DIR=.omp-sandbox-runh` (a relative name; the harness joins it onto the home dir) redirects the entire config root — plugins, logs, stats, caches — into a fresh tree. It is set on every spawned process, including `plugin list`.
- The sandbox's `plugins/node_modules` holds junctions to the repo working tree (`omp-skill-state`, so the live code is this checkout), to `verification/capture` (`skill-state-capture`) and to the profile's other plugin (`pi-proxy`).
- The sandbox `agent/` config (auth db, config.yml, settings.json, models.yml, models.db, mcp.json, skills, tools) is copied read-only from the live profile once; the live profile is never written.
- Driven sessions run with `--cwd` on a fresh throwaway workspace dir (never the repo) and `--session-dir verification/sessions` (gitignored). The capture plugin is dormant unless `SKILL_STATE_CAPTURE_DIR` is set; it appends every provider request body to `<dir>/requests.jsonl`. Capture dirs are pre-created: the plugin appends fire-and-forget and silently drops lines when the dir is missing.
- Evidence: `bun verification/analyze.ts <session.jsonl>` reads the stored transcript and prints the step timeline, token statistics over the projected steps, the compaction entries and the last stored state.
- The capture corpora may contain leftover request bodies from an earlier aborted attempt of this ticket (timestamps before 2026-10-13T18:45Z in capture-h, before 18:39Z in capture-probe); all counts below are over the run's own window only.

Projected step: an assistant message produced while a state head message is on the branch. Prompt tokens: `input + cacheRead + cacheWrite` of that message's usage.

## Print mode does not engage

`omp -p "/skill:zstate …"` in the sandbox (omp 18.10.3, `glm-5.3-flash`): 3 provider requests captured, the session shows 0 skill-prompt messages and 0 state messages, and the model's one `state_update` attempt was answered `no active procedure` (5 occurrences in the transcript, on the tool result and the reply). Print mode hands the draft to `session.prompt` verbatim — the `/skill:` dispatch that produces the user-attributed skill-prompt message exists only on the interactive, ACP and RPC paths, so a procedure cannot engage in print mode. The issue's fallback applies: the TUI in a pty drives the acceptance run. `perCall` occurrences in the probe corpus: 0 of 3.

## Run H, the acceptance run

Session `01a13695-6656-7000-ac55-09dd4ecb40d8` (`verification/sessions/2026-10-13T18-45-23-158Z_01a13695-6656-7000-ac55-09dd4ecb40d8.jsonl`), one TUI process in a pty, omp 18.10.3, `--model glm-5.3-flash --thinking low --config verification/compact-early.yml`, sandbox profile as above. Duration ≈ 13 min. Invocation: `/skill:zstate` with a four-part task over a 700-line / 52,500-byte fixture `big.txt`: (1) one deliberate invalid patch, (2) record the file's entire contents verbatim as one findings string, (3) consolidate under the state cap, (4) report the line count.

Steps: 15 provider calls, 14 projected (the first is the engage step, no stored head yet — it neither counts nor nudges); the capture corpus holds 16 bodies because one request was captured twice on a provider retry (seqs 2–3, same shape, 2 s apart). `stateChangedSteps` 12, state messages 30, compactions 2 (both `fromExtension: true`, each with the state summary and `preserveData` carrying both partitions): 43417 → 37617 and 40365 → 8326 tokens.

Prompt tokens per projected step: min 9760, median 10289, p90 28031, max 39721 (max/median 3.86 — the two compaction re-sends inflate the max; the flat-procedure picture is the median). Uncached input per projected step: min 132, median 5296, max 35177.

Cache: `cacheRead > 0` on 14/14 projected steps — every projected step, including both post-compaction steps. Where the head was byte-stable the read pins in the 9536–10304 band (steps: 10176, 10304, 9536, 9664); steps whose scratch state or observation window churned read 4544 (the prefix through the stable head messages ahead of the first changed one — the cache ceiling doing its job).

The three behaviours over the top-level `state_update` tool:

- Patch step: five commits across the run (the engage with `goal`/`working_dir`, the refusal finding, the verbatim blob, the consolidation, plus the idle-threshold commit below; a sixth `state_update` folded to no change and committed nothing). The verbatim commit carried the entire 52,500-byte file as one `$append`ed findings string in a single patch (15,386 output tokens).
- Schema refusal: the reply's `state_update` with `{"next_step": 1}` was refused by the fold — tool result `state key "next_step" must be a string (was number)` — the step blocked, the exact text recorded in findings, corrected next step; `retries` never went past 1 of 3, no degrade.
- Cap ask: with the blob committed the state measured over the 32,768-byte `stateBytes` cap, and the consolidation ask rode capture seqs 7–9: the over-cap step's request (rebuilt after the first compaction), then the next two steps' requests, which still carried it although the consolidation commit had already landed — the provenance line is already in their heads. The consolidation commit replaced the blob with a provenance line (`big.txt: exactly 700 lines; first line: …`); no request from capture seq 10 on carried the ask.

Final answer from the state alone: 700 lines. Final state: `goal`, `working_dir` in the state core; `next_step`, `plan`, `findings` (2 items) in the scratch state; the invalid-patch refusal text preserved verbatim as a finding.

Idle threshold: five reply-only prompts after the final answer walked the idle counter to 7 (`idleSteps` is 8 for the bundled skill); the next request carried the idle nudge verbatim — `The execution state has been unchanged for 7 consecutive steps. One more step without a state_update patch that changes the state disengages this procedure and returns the session to ordinary history-based execution. If there is anything worth keeping, record it in the state now with a state_update patch.` — and the reply riding that same request carried `state_update` `{"next_step": "idle threshold probe"}`, which committed (`execution state updated`), reset the idle counter and left the procedure engaged: 0 occurrences of `disengaged`, 0 of `no active procedure` in the transcript. The lost-patch defect the run G probe saw on the old `xd://` mount did not reproduce: on the shipped top-level channel the patch lands. Verdict: cleared.

Capture corpus (window t ≥ 2026-10-13T18:45Z): 16 request bodies, all `glm-5.3-flash`; `perCall` occurrences: 0.

## Run G, the baseline (numbers only)

Run G rode the superseded `xd://state_update` mount; its measurements are kept as the baseline the new channel is compared against.

- `cacheRead` pinned at 10496 from step 7 through step 54 (and again on 56) — system prompt, tools, rules, procedure spec, state core, byte-equal on every patched step.
- Prompt tokens per step: min 11349, median 14211, p90 14527, max 17232. `cacheRead > 0` on 57/58 projected steps (misses: the engage, a state-core-fill step, first call after a resume). Uncached input median 3778.
- Per-call mark on the wire: 0 occurrences in 59 captured request bodies (its probe corpus: 0 of 20).

## Comparison

Run H's settled pin band 9536–10304 sits 192–960 tokens under run G's 10496 (−1.8 % to −9.1 %). Both profiles share the prefix structure (system prompt, tools, rules, procedure spec, state core); the delta is consistent with the harness moving 18.10.2 → 18.10.3 between the runs' profiles and run H's shorter stable stretch. The head split's benefit survives the channel change: the prompt stays flat while the state turns over, and every projected step once the head settles reads cache-positive (G: 57/58 with three cold steps; H: 14/14).

## Pending: the post-redesign acceptance runs

No post-redesign figures exist yet. The pending re-measurements, taken on the acceptance runs below: the cache pin — where the durable breakpoint lands under ADR 0011's layout, the tail's tagged tool-result copies included — with run H's 9536–10304 band as the floor; the tail's budget behaviour, prompt inside the budget with a sawtooth at evictions; the mirror repair on a resume whose stored head disagrees with it; and `state_recall`'s read-back with its cap marker.

The four acceptance classes also await the user's recorded sessions, whose transcripts are read afterwards: an ordinary coding session, a long research run, a trajectory-as-objective run (an audit, "what changed and why", debug provenance), and a multi-skill session with a mid-run second-skill invocation. The measured cache-read figures and the prompt-size-inside-budget check are recorded with those transcripts and stay pending until they exist.

## Not covered

- The degrade path was not observed live; the single-block case was (run H's schema refusal). A rewind and the inert cases rest on the unit tests.
- One model and one provider; cache figures are what `zai` reports for `glm-5.3-flash`.
- Print mode cannot engage — interactive/ACP/RPC dispatch only — so no print-mode run can serve as acceptance evidence.
