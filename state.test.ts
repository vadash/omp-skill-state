import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { applyPatch, loadStateSchema, mergeState, splitState, stateEquals, validatePatch, volatileKeys } from "./state";
import type { ExecutionState, JsonSchema, StateSchema } from "./state";
import { makeSkill } from "./skill-fixtures";

let root: string;
let valid: Skill;
let partial: Skill;
let defaulted: Skill;
let malformed: Skill;
let arrayTop: Skill;
let nullTop: Skill;
let stringTop: Skill;
let numberTop: Skill;
let plain: Skill;
let garbage: Skill;
let windowed: Skill;
let zerowindow: Skill;
let capped: Skill;
let negcap: Skill;

beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), "omp-skill-state-core-"));
	valid = await makeSkill(root, "valid", JSON.stringify({
		type: "object",
		properties: { goal: { type: "string" } },
		"x-state": { observationBytes: 4096, idleSteps: 5, retries: 2 },
	}));
	partial = await makeSkill(root, "partial", JSON.stringify({ "x-state": { idleSteps: 7 } }));
	defaulted = await makeSkill(root, "defaulted", JSON.stringify({ type: "object", properties: {} }));
	malformed = await makeSkill(root, "malformed", "{ not json");
	arrayTop = await makeSkill(root, "arraytop", "[]");
	nullTop = await makeSkill(root, "nulltop", "null");
	stringTop = await makeSkill(root, "stringtop", '"text"');
	numberTop = await makeSkill(root, "numbertop", "42");
	plain = await makeSkill(root, "plain");
	garbage = await makeSkill(root, "garbage", JSON.stringify({
		"x-state": { observationBytes: "65536", idleSteps: 2, retries: null },
	}));
	windowed = await makeSkill(root, "windowed", JSON.stringify({
		"x-state": { observationWindow: 3 },
	}));
	zerowindow = await makeSkill(root, "zerowindow", JSON.stringify({
		"x-state": { observationWindow: 0 },
	}));
	capped = await makeSkill(root, "capped", JSON.stringify({
		"x-state": { stateBytes: 4096 },
	}));
	negcap = await makeSkill(root, "negcap", JSON.stringify({
		"x-state": { stateBytes: -5 },
	}));
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("loadStateSchema", () => {
	test("loads a valid schema with x-state params", async () => {
		const loaded = await loadStateSchema("valid", [valid]);

		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.params).toEqual({ observationBytes: 4096, observationWindow: 1, idleSteps: 5, retries: 2, stateBytes: 0 });
		expect(loaded.schema.properties?.goal).toEqual({ type: "string" });
	});

	test("fills unset x-state fields from defaults", async () => {
		const loaded = await loadStateSchema("partial", [partial]);

		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.params).toEqual({ observationBytes: 32768, observationWindow: 1, idleSteps: 7, retries: 3, stateBytes: 0 });
	});

	test("uses defaults when x-state is absent", async () => {
		const loaded = await loadStateSchema("defaulted", [defaulted]);

		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.params).toEqual({ observationBytes: 32768, observationWindow: 1, idleSteps: 5, retries: 3, stateBytes: 0 });
	});

	test("reads the observation window and floors values below one", async () => {
		const withWindow = await loadStateSchema("windowed", [windowed]);
		const zero = await loadStateSchema("zerowindow", [zerowindow]);

		expect(withWindow.ok).toBe(true);
		expect(zero.ok).toBe(true);
		if (!withWindow.ok || !zero.ok) return;
		expect(withWindow.params.observationWindow).toBe(3);
		expect(zero.params.observationWindow).toBe(1);
	});

	test("reads the state cap and clamps values below zero to the disabled default", async () => {
		const withCap = await loadStateSchema("capped", [capped]);
		const negative = await loadStateSchema("negcap", [negcap]);

		expect(withCap.ok).toBe(true);
		expect(negative.ok).toBe(true);
		if (!withCap.ok || !negative.ok) return;
		expect(withCap.params.stateBytes).toBe(4096);
		expect(negative.params.stateBytes).toBe(0);
	});

	test("ignores non-numeric x-state fields", async () => {
		const loaded = await loadStateSchema("garbage", [garbage]);

		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.params).toEqual({ observationBytes: 32768, observationWindow: 1, idleSteps: 2, retries: 3, stateBytes: 0 });
	});
});

describe("loadStateSchema failures", () => {
	test("missing schema file fails without throwing", async () => {
		const loaded = await loadStateSchema("plain", [plain]);
		expect(loaded).toEqual({ ok: false, error: expect.any(String) });
	});

	test("unknown skill name fails without throwing", async () => {
		const loaded = await loadStateSchema("nosuch", [plain]);
		expect(loaded).toEqual({ ok: false, error: expect.any(String) });
	});

	test("malformed JSON fails", async () => {
		const loaded = await loadStateSchema("malformed", [malformed]);
		expect(loaded.ok).toBe(false);
	});

	test("array top level fails", async () => {
		const loaded = await loadStateSchema("arraytop", [arrayTop]);
		expect(loaded.ok).toBe(false);
	});

	test("null top level fails", async () => {
		const loaded = await loadStateSchema("nulltop", [nullTop]);
		expect(loaded.ok).toBe(false);
	});

	test("string top level fails", async () => {
		const loaded = await loadStateSchema("stringtop", [stringTop]);
		expect(loaded.ok).toBe(false);
	});

	test("number top level fails", async () => {
		const loaded = await loadStateSchema("numbertop", [numberTop]);
		expect(loaded.ok).toBe(false);
	});
});

describe("validatePatch types", () => {
	const schemaWith = (name: string, sub: JsonSchema): StateSchema => ({
		type: "object",
		properties: { [name]: sub },
	});

	test("string value passes, wrong type fails", () => {
		const schema = schemaWith("goal", { type: "string" });
		expect(validatePatch({ goal: "ship" }, schema)).toBeNull();
		expect(validatePatch({ goal: 1 }, schema)).toContain("goal");
	});

	test("number value passes, wrong type fails", () => {
		const schema = schemaWith("count", { type: "number" });
		expect(validatePatch({ count: 2 }, schema)).toBeNull();
		expect(validatePatch({ count: "two" }, schema)).toContain("count");
	});

	test("boolean value passes, wrong type fails", () => {
		const schema = schemaWith("done", { type: "boolean" });
		expect(validatePatch({ done: true }, schema)).toBeNull();
		expect(validatePatch({ done: "yes" }, schema)).toContain("done");
	});

	test("null value passes, wrong type fails", () => {
		const schema = schemaWith("error", { type: "null" });
		expect(validatePatch({ error: null }, schema)).toBeNull();
		expect(validatePatch({ error: "boom" }, schema)).toContain("error");
	});

	test("array value passes, wrong type and element type fail", () => {
		const schema = schemaWith("tags", { type: "array", items: { type: "string" } });
		expect(validatePatch({ tags: ["a", "b"] }, schema)).toBeNull();
		expect(validatePatch({ tags: "a" }, schema)).toContain("tags");
		const error = validatePatch({ tags: ["a", 2] }, schema);
		expect(error).toContain("tags");
		expect(error).toContain("[1]");
	});

	test("object value passes, nested property type fails", () => {
		const schema = schemaWith("meta", { type: "object", properties: { depth: { type: "number" } } });
		expect(validatePatch({ meta: { depth: 3 } }, schema)).toBeNull();
		const error = validatePatch({ meta: { depth: "deep" } }, schema);
		expect(error).toContain("meta");
		expect(error).toContain("depth");
	});

	test("nested additionalProperties false rejects unknown nested key", () => {
		const schema = schemaWith("meta", { type: "object", additionalProperties: false, properties: { depth: { type: "number" } } });
		expect(validatePatch({ meta: { depth: 1 } }, schema)).toBeNull();
		expect(validatePatch({ meta: { extra: true } }, schema)).toContain("extra");
	});

	test("subschema with no type imposes no constraint", () => {
		const schema = schemaWith("free", {});
		expect(validatePatch({ free: [1, { a: null }] }, schema)).toBeNull();
	});
});

describe("validatePatch unknown keys", () => {
	const schema: StateSchema = { type: "object", properties: { goal: { type: "string" } } };

	test("additionalProperties true accepts an unknown key", () => {
		expect(validatePatch({ extra: 1 }, { ...schema, additionalProperties: true })).toBeNull();
	});

	test("additionalProperties false rejects an unknown key", () => {
		const error = validatePatch({ extra: 1 }, { ...schema, additionalProperties: false });
		expect(error).toContain("extra");
	});

	test("absent additionalProperties accepts an unknown key", () => {
		expect(validatePatch({ extra: 1 }, schema)).toBeNull();
	});
});

describe("validatePatch top level", () => {
	const schema: StateSchema = { type: "object", properties: {} };

	test("rejects an array patch", () => {
		expect(validatePatch([], schema)).toContain("JSON object");
	});

	test("rejects a null patch", () => {
		expect(validatePatch(null, schema)).toContain("JSON object");
	});

	test("rejects a string patch", () => {
		expect(validatePatch("nope", schema)).toContain("JSON object");
	});
});

describe("mergeState", () => {
	test("sets a new key", () => {
		expect(mergeState({}, { a: 1 })).toEqual({ a: 1 });
	});

	test("null deletes a key", () => {
		expect(mergeState({ a: 1, b: 2 }, { a: null })).toEqual({ b: 2 });
	});

	test("keys absent from the patch are untouched", () => {
		expect(mergeState({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
	});

	test("nested objects merge key-wise", () => {
		expect(mergeState({ meta: { a: 1, b: 2 } }, { meta: { b: 3, c: 4 } })).toEqual({ meta: { a: 1, b: 3, c: 4 } });
	});

	test("arrays replace", () => {
		expect(mergeState({ tags: ["a", "b"] }, { tags: ["c"] })).toEqual({ tags: ["c"] });
	});

	test("scalars replace, including over objects", () => {
		expect(mergeState({ a: 1, meta: { b: 2 } }, { a: 9, meta: 5 })).toEqual({ a: 9, meta: 5 });
	});

	test("nested null deletes a nested key", () => {
		expect(mergeState({ meta: { a: 1, b: 2 } }, { meta: { b: null } })).toEqual({ meta: { a: 1 } });
	});

	test("does not mutate t or patch", () => {
		const t: ExecutionState = { keep: "yes", nested: { a: 1, b: 2 }, tags: ["x"] };
		const patch: ExecutionState = { keep: null, nested: { b: null, c: 3 }, tags: ["y"], fresh: true };
		const tSnapshot = structuredClone(t);
		const patchSnapshot = structuredClone(patch);

		const merged = mergeState(t, patch);

		expect(merged).toEqual({ nested: { a: 1, c: 3 }, tags: ["y"], fresh: true });
		expect(t).toEqual(tSnapshot);
		expect(patch).toEqual(patchSnapshot);
	});
});

describe("validatePatch null deletion", () => {
	const schema: StateSchema = {
		type: "object",
		properties: {
			goal: { type: "string" },
			tags: { type: "array", items: { type: "string" } },
			meta: { type: "object", properties: { depth: { type: "number" } } },
		},
	};

	test("null passes validation against every declared type, because it deletes", () => {
		expect(validatePatch({ goal: null }, schema)).toBeNull();
		expect(validatePatch({ tags: null }, schema)).toBeNull();
		expect(validatePatch({ meta: null }, schema)).toBeNull();
		expect(validatePatch({ meta: { depth: null } }, schema)).toBeNull();
	});

	test("applying a null patch deletes the declared key", () => {
		const applied = applyPatch({ goal: "old", tags: ["a"] }, { goal: null }, schema);
		expect(applied.ok).toBe(true);
		if (applied.ok) expect(applied.state).toEqual({ tags: ["a"] });
	});

	test("applying a nested null deletes only the nested key", () => {
		const nested: StateSchema = { type: "object", properties: { meta: { type: "object", properties: { depth: { type: "number" } } } } };
		const applied = applyPatch({ meta: { depth: 3, kept: true } }, { meta: { depth: null } }, nested);
		expect(applied.ok).toBe(true);
		if (applied.ok) expect(applied.state).toEqual({ meta: { kept: true } });
	});
});

describe("validatePatch $append", () => {
	const schema: StateSchema = { type: "object", properties: { findings: { type: "array", items: { type: "string" } } } };

	test("an $append op validates against the array schema and its items", () => {
		expect(validatePatch({ findings: { $append: ["a"] } }, schema)).toBeNull();
		const error = validatePatch({ findings: { $append: [1] } }, schema);
		expect(error).toContain("findings");
		expect(error).toContain("$append[0]");
	});

	test("a non-array $append payload is rejected", () => {
		const error = validatePatch({ findings: { $append: "a" } }, schema);
		expect(error).toContain("findings");
		expect(error).toContain("$append");
	});

	test("$append merges onto the current array instead of replacing it", () => {
		expect(mergeState({ findings: ["x"], goal: "g" }, { findings: { $append: ["a", "b"] } } as ExecutionState)).toEqual({
			findings: ["x", "a", "b"],
			goal: "g",
		});
	});

	test("$append to a missing key initializes the array", () => {
		const applied = applyPatch({}, { findings: { $append: ["val"] } }, schema);
		expect(applied.ok).toBe(true);
		if (applied.ok) expect(applied.state).toEqual({ findings: ["val"] });
	});

	test("$append of an empty array to an existing key changes nothing", () => {
		expect(mergeState({ findings: ["x"] }, { findings: { $append: [] } })).toEqual({ findings: ["x"] });
	});

	test("$append never recurses into an object-keyed merge", () => {
		expect(mergeState({ meta: { a: 1 } }, { meta: { $append: ["x"] } } as ExecutionState)).toEqual({ meta: ["x"] });
	});
});

describe("applyPatch", () => {
	const schema: StateSchema = { type: "object", properties: { goal: { type: "string" } } };

	test("merges a valid patch and reports the change", () => {
		expect(applyPatch({ goal: "old" }, { goal: "new" }, schema)).toEqual({ ok: true, state: { goal: "new" }, changed: true });
	});

	test("a patch that leaves the state as it was reports changed false", () => {
		expect(applyPatch({ goal: "x" }, { goal: "x" }, schema)).toEqual({ ok: true, state: { goal: "x" }, changed: false });
		expect(applyPatch({ goal: "x" }, { gone: null }, schema)).toEqual({ ok: true, state: { goal: "x" }, changed: false });
	});

	test("rejects an invalid patch and leaves the state untouched", () => {
		const t: ExecutionState = { goal: "keep" };
		const result = applyPatch(t, { goal: 42 }, schema);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("goal");
		expect(t).toEqual({ goal: "keep" });
	});
});

describe("stateEquals", () => {
	test("equal states compare equal regardless of key order", () => {
		expect(stateEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
		expect(stateEquals({ meta: { a: 1, b: [1, { c: 2 }] } }, { meta: { b: [1, { c: 2 }], a: 1 } })).toBe(true);
	});

	test("differences in keys, values or nesting compare unequal", () => {
		expect(stateEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(stateEquals({ a: 1 }, { a: 2 })).toBe(false);
		expect(stateEquals({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
		expect(stateEquals({ a: { b: 1 } }, { a: { b: 1, c: 2 } })).toBe(false);
		expect(stateEquals({ a: 1 }, {})).toBe(false);
		expect(stateEquals({}, { a: 1 })).toBe(false);
	});
});

describe("volatileKeys", () => {
	test("reads the x-state volatile list", () => {
		expect(volatileKeys({ type: "object", "x-state": { volatile: ["plan", "findings"] } })).toEqual(["plan", "findings"]);
	});

	test("an empty list is a valid list", () => {
		expect(volatileKeys({ type: "object", "x-state": { volatile: [] } })).toEqual([]);
	});

	test("a missing x-state or volatile field is an empty list", () => {
		expect(volatileKeys({ type: "object" })).toEqual([]);
		expect(volatileKeys({ type: "object", "x-state": {} })).toEqual([]);
	});

	test("a non-array volatile field, or one holding a non-string, is invalid and empty", () => {
		expect(volatileKeys({ type: "object", "x-state": { volatile: "plan" } })).toEqual([]);
		expect(volatileKeys({ type: "object", "x-state": { volatile: ["plan", 3] } })).toEqual([]);
		expect(volatileKeys({ type: "object", "x-state": { volatile: null } })).toEqual([]);
	});
});

describe("splitState", () => {
	const schema: StateSchema = {
		type: "object",
		properties: { goal: { type: "string" }, plan: { type: "array" } },
	};

	test("declared non-volatile keys are the state core, volatile and undeclared keys the scratch", () => {
		const state: ExecutionState = { goal: "x", plan: ["a"], stray: 1 };
		const { core, scratch } = splitState(state, schema, ["plan"]);

		expect(core).toEqual({ goal: "x" });
		expect(scratch).toEqual({ plan: ["a"], stray: 1 });
	});

	test("with an empty volatile list every declared key is core and only undeclared keys are scratch", () => {
		const { core, scratch } = splitState({ goal: "x", stray: 1 }, schema, []);

		expect(core).toEqual({ goal: "x" });
		expect(scratch).toEqual({ stray: 1 });
	});

	test("an empty state splits to two empty partitions", () => {
		expect(splitState({}, schema, ["plan"])).toEqual({ core: {}, scratch: {} });
	});

	test("the partitions are disjoint and the input is not mutated", () => {
		const state: ExecutionState = { goal: "x", plan: ["a"] };
		const { core, scratch } = splitState(state, schema, ["plan"]);

		expect(Object.keys(core).filter((key) => key in scratch)).toEqual([]);
		expect(state).toEqual({ goal: "x", plan: ["a"] });
	});
});
