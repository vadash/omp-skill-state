# A declared open object answers exploratory discovery; no promotion or declaration operators

Discoveries that fit no declared key land undeclared in the scratch — untyped by design, per-call by construction — so a fact that freezes early (a 5 KB route list after recon) re-bills on every remaining step, ~80K uncached tokens across a 65-step tail, and a typo'd key persists as parallel untyped truth. We answer this by authoring, not by operators: the state schema subset accepts `additionalProperties` as a schema, and a skill declares a *knowledge bag* — an object-typed key, open to any JSON value, holding stable discovered facts. The bag is declared, so it lives in the state core and its bytes cache; the merge already recurses through plain objects, so facts accrue key-wise without re-emission; it is declared, so a re-derive restores it natively with no new persistence. An anticipated frozen array is a declared key kept off the explicit `x-state.volatile` list — the explicit list is authoritative, so the key takes the core and caches once it freezes. No `$promote`, no `$declare`.

## Considered options

- **`$promote`, a patch operator moving a scratch key into the core.** The partition must then survive re-derive: the branch scan flattens the stored state pair into one state and the split re-assigns undeclared keys to the scratch, so promoted keys silently demote on `/resume` unless the re-derive treats the stored core's keyset as authoritative — new threading through the branch scan, the procedure record and the split. The bag and declared frozen keys cover both discovery lifecycles by authoring, with zero persistence machinery.
- **`$declare`, declaring a key's schema from the patch.** Buys typing the bag already provides, at the cost of rules text, declare-then-use validation ordering and schema persistence, for a mechanism with no demonstrated typo rate in verification runs.
- **A strings-only bag.** Numbers, booleans and nested facts are routine discoveries; typing the bag `string` turns `db_port: 5432` into a validation retry.

## Consequences

The runtime change is the schema-subset union and the member-validation path it enables; the bundled zstate skill ships `knowledge` and authoring guidance: route stable facts into the bag, keep anticipated array keys off the volatile list. Skills that do not opt in pay nothing — the bag's teaching lives in the procedure spec, not the operating rules. Bag members stay untyped unless a skill narrows `additionalProperties`; the deep check still guards prototype-hazard keys at every depth.
