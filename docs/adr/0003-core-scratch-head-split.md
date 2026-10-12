# The head splits into a stable core and a per-call scratch

Prefix caching diverges at the first changed byte, and the execution state changes on nearly every step, so with a single state message nothing after the procedure spec was byte-stable across steps: roughly a third of each step's prompt re-billed, and on Anthropic-shaped providers — where the harness places only trailing cache anchors unless some message is per-call — even the rules and the spec re-billed. We split the state into two stored head messages: a *state core* (schema keys expected to hold; an `x-state.volatile` list names the scratch keys, and unlisted or new keys land in scratch) and a *scratch state* (plan-like keys that change most steps), ordered rules, spec, core, scratch. The projection returns the scratch message as a deliberately differing copy, so the harness marks it per-call and places its durable sub-prefix cache breakpoint on the newest stable message before it — the last core message. The cache ceiling rises from through-the-spec to through-the-core, and the deliberate mark makes that placement deterministic instead of dependent on the cap happening to fire.

## Considered options

- **Rewrite `cache_control` in `before_provider_request`.** Provider-coupled wire surgery for what the per-call marking achieves declaratively through the public context event.
- **Ask upstream for a breakpoint-hint API.** The clean long-term fix; revisit if the harness grows one.
- **Reorder so the state comes last.** No effect: prefix matching stops at the first differing message wherever it sits.

## Consequences

The head is four stored messages; re-derive, compaction (both state messages carried in summary and preserve-data) and the transcript renderer handle both, and an invocation whose branch lacks either state message is an incomplete head that stays inert. The copy's distinguishing field must live outside model-visible content: a unit test pins the copy's shape, and every real-session verification run re-checks that the provider payload never sees the field. On OpenAI-style implicit prefix caching the ceiling is through-the-core; on Anthropic the mark is what anchors it.
