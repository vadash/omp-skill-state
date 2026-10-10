# omp-skill-state

An omp plugin that runs a procedural skill against an explicit execution state. Each provider call sends the model only the triple `(P, t, O_t)`: the skill body, the current state, the current step's observation. This per-step rewrite is the **projection**; it replaces the prompt and never the stored transcript.

Two invariants hold in every change:

- The projection reads and writes the prompt only. The transcript on disk and on the branch stays complete.
- The harness checkout at `C:\projects\_llm\oh-my-pi` is a read-only reference. Nothing under it is modified. Every mechanism goes through the public `ExtensionAPI`; its reference is that checkout's `docs/extensions.md`, and its source is where to verify how an event or action behaves.

Read before designing or implementing any behaviour: `docs/spec.md`. It fixes the lifecycle (inert, armed, engaged, degraded), the merge operator, the message order of the projection, the patch validation ordering, and every harness surface used. `docs/adr/0001` records why the runtime owns compaction while engaged.

## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels are used as-is (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
