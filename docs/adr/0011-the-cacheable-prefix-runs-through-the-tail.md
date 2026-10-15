# The cacheable prefix runs through the tail, and eviction is chunked

Two harness facts decide the prompt layout. A prompt message is marked per-call exactly when its bytes differ from its stored counterpart, and the durable cache breakpoint lands on the newest stable message before the first per-call one. And a message the projection synthesizes has no stored counterpart, so it is per-call by construction.

The first fact is why the state must keep its stored messages: a synthesized state message would move the breakpoint back to the system prompt and tools, and the whole head would re-bill every step. The second is why a volatile region must not sit early: with the scratch inside the head, everything behind the state core — the observation, and a tail if one were placed there — can never be cached, because the region before it changes on most steps.

So the head order becomes **rules, procedure spec, state core, tail, scratch, observation**. The cached prefix then reaches through the tail, which is stored material returned byte-unchanged; only the tail's newest messages, the scratch and the per-call notices re-bill. The prompt budget becomes a fraction of the model's window (`ctx.getContextUsage()`), 30% by default, and the tail takes what the head, the scratch and a reserve leave. Eviction is chunked — a quarter of the tail budget at a time — because a front that moves every step re-bills the whole tail on every step.

## Considered options

- **Scratch before the tail** (today's order, with the tail appended after it): rejected — the cached prefix ends at the state core, so the tail re-bills in full on every step and the budget buys nothing caching would not.
- **Per-step eviction** to hold the budget exactly: rejected — a sawtooth-free prompt costs a full tail re-bill every step; a chunked sawtooth costs one every several.
- **A fixed token budget** rather than a fraction: rejected — the window differs per model and per profile, and a fixed number is wrong on most of them.
- **A synthesized head** (rules, spec, tail or state built by the projection): rejected for the reason above; the same reason retires appending the spec to the system prompt.

## Consequences

- The prompt size sawtooths between evictions.
- The measured anchor from run H — `cacheRead` pinned at 9,536–10,304, covering system prompt, tools, rules, spec and state core — becomes the floor of the cached prefix rather than its ceiling. The acceptance run must re-measure it, and the tail's contribution to it.
- `promptBudgetPercent` and `evictionChunkPercent` join the parameters of section 15; `observationBytes` becomes the cap on a single tool result in the tail, and `observationWindow` is deleted.
