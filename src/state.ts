import { readFile } from "node:fs/promises";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { isPlainObject } from "./types";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export type ExecutionState = Record<string, JsonValue>;

export interface JsonSchema {
	type?: "string" | "number" | "boolean" | "array" | "object" | "null";
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	additionalProperties?: boolean | JsonSchema;
	[k: string]: unknown;
}

export interface StateSchema extends JsonSchema {
	"x-state"?: unknown;
}

export interface StateParams {
	observationBytes: number;
	observationWindow: number;
	stateBytes: number;
	idleSteps: number;
	retries: number;
}

export const DEFAULT_PARAMS: StateParams = { observationBytes: 65536, observationWindow: 3, stateBytes: 0, idleSteps: 5, retries: 3 };

export type SchemaLoad =
	| { ok: true; schema: StateSchema; params: StateParams }
	| { ok: false; error: string };

export type PatchApply =
	| { ok: true; state: ExecutionState; changed: boolean }
	| { ok: false; error: string };

// Structural equality of two execution states, key order independent. The one
// test for whether a patch changed anything: the step policy and the tool
// execute consult the same answer through PatchApply, so they can never
// classify the same step differently.
export function stateEquals(a: ExecutionState, b: ExecutionState): boolean {
	const aKeys = Object.keys(a);
	if (aKeys.length !== Object.keys(b).length) return false;
	for (const key of aKeys) {
		if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
		if (!jsonEquals(a[key], b[key])) return false;
	}
	return true;
}

// Order-insensitive deep equality over JSON values; scalars by identity.
function jsonEquals(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => jsonEquals(item, b[i]));
	if (isPlainObject(a) && isPlainObject(b)) {
		const aKeys = Object.keys(a);
		if (aKeys.length !== Object.keys(b).length) return false;
		return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && jsonEquals(a[key], b[key]));
	}
	return false;
}

// Pure schema parsing: the shape check plus parameter clamping, no I/O. The
// in-memory seam the unit tests table over; loadStateSchema wraps it around
// the file read.
export function parseStateSchema(parsed: unknown): SchemaLoad {
	if (!isPlainObject(parsed)) return { ok: false, error: "state schema is not a JSON object" };
	const schema = parsed as StateSchema;
	return { ok: true, schema, params: readParams(schema["x-state"]) };
}

// A missing or malformed schema is a returned failure, not a throw: a skill
// without a usable state.schema.json is an ordinary skill and must stay silent.
export async function loadStateSchema(skillName: string, skills: readonly Skill[]): Promise<SchemaLoad> {
	try {
		const schemaPath = await InternalUrlRouter.instance().locate(`skill://${skillName}/state.schema.json`, { skills });
		if (schemaPath === null) return { ok: false, error: `no state.schema.json for skill "${skillName}"` };
		const loaded = parseStateSchema(JSON.parse(await readFile(schemaPath, "utf8")));
		// The pure seam cannot know the skill; the I/O wrapper names the file.
		if (!loaded.ok) return { ok: false, error: `state.schema.json for "${skillName}": ${loaded.error}` };
		return loaded;
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function readParams(raw: unknown): StateParams {
	if (!isPlainObject(raw)) return { ...DEFAULT_PARAMS };
	const pick = (value: unknown, fallback: number): number =>
		typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return {
		observationBytes: pick(raw.observationBytes, DEFAULT_PARAMS.observationBytes),
		// A window of zero or fewer pairs would drop even the newest observation, so it clamps to one.
		observationWindow: Math.max(1, pick(raw.observationWindow, DEFAULT_PARAMS.observationWindow)),
		// A cap of zero or less disables the nudge: the cap is opt-in per skill.
		stateBytes: Math.max(0, pick(raw.stateBytes, DEFAULT_PARAMS.stateBytes)),
		idleSteps: pick(raw.idleSteps, DEFAULT_PARAMS.idleSteps),
		retries: pick(raw.retries, DEFAULT_PARAMS.retries),
	};
}

// All-or-nothing: callers must not merge a patch unless this returns null.
export function validatePatch(patch: unknown, schema: StateSchema): string | null {
	if (!isPlainObject(patch)) return "state patch must be a JSON object";
	const error = validateRootOperators(patch, schema);
	if (error !== null) return error;
	return validateObject(patch, schema, "");
}

// The two patch operators (ADR 0004): root keys whose value maps state keys
// to item arrays, so an array edit beside a key set needs no nested braces.
// The $ namespace is reserved for operators.
const OPERATORS = ["$append", "$remove"] as const;

// The patch-root walk: an unknown $-prefixed key rejects, one state key
// cannot carry two writes in one patch (set + operate, or both operators),
// and each operator payload validates like any value of its target key —
// item-wise against the declared array's items schema, or against the deep
// check where no schema walks. The plain keys validate in validateObject.
function validateRootOperators(patch: Record<string, unknown>, schema: StateSchema): string | null {
	const properties = isPlainObject(schema.properties) ? schema.properties : {};
	const sets = new Set<string>();
	const appended: string[] = [];
	const removed: string[] = [];
	for (const key of Object.keys(patch)) {
		if (!key.startsWith("$")) {
			sets.add(key);
			continue;
		}
		if (key !== "$append" && key !== "$remove") {
			return `unknown state patch operator "${key}"; the operators are $append and $remove, e.g. {"$append": {"findings": ["item"]}}`;
		}
		const map = patch[key];
		if (!isPlainObject(map)) return `state key "${key}" must be an object mapping state keys to item arrays, e.g. {"${key}": {"findings": [items]}}`;
		for (const target of Object.keys(map)) {
			if (isHazardKey(target)) return `invalid state key "${key}.${target}"`;
		}
		(key === "$append" ? appended : removed).push(...Object.keys(map));
	}
	for (const target of appended) {
		if (sets.has(target)) return `state key "${target}" cannot be both set and $appended in one patch; emit only {"$append": {"${target}": [items]}}`;
		if (removed.includes(target)) return `state key "${target}" cannot be both $appended and $removed in one patch; keep only one operator, e.g. {"$append": {"${target}": [items]}}`;
	}
	for (const target of removed) {
		if (sets.has(target)) return `state key "${target}" cannot be both set and $removed in one patch; emit only {"$remove": {"${target}": [items]}}`;
	}
	for (const op of OPERATORS) {
		const map = patch[op] as Record<string, unknown>;
		for (const target of op === "$append" ? appended : removed) {
			const payload = map[target];
			if (!Array.isArray(payload)) return `state key "${op}.${target}" must be an array of items, e.g. {"${op}": {"${target}": [items]}}`;
			const sub = properties[target];
			const error = sub === undefined ? checkDeepPatch(payload, `${op}.${target}`) : validateValue(payload, sub, `${op}.${target}`);
			if (error !== null) return error;
		}
	}
	return null;
}

// The keys whose assignment would reach the object's prototype machinery
// instead of its own properties. Banned from the state at every depth.
function isHazardKey(key: string): boolean {
	return key === "__proto__" || key === "constructor" || key === "prototype";
}

function validateObject(obj: Record<string, unknown>, schema: JsonSchema, path: string): string | null {
	const properties = isPlainObject(schema.properties) ? schema.properties : {};
	for (const key of Object.keys(obj)) {
		// Operator maps are data-checked by the root operator walk; below the
		// patch root a $-prefixed key is plain data like any other.
		if (path === "" && key.startsWith("$")) continue;
		if (isHazardKey(key)) {
			return `invalid state key "${path ? `${path}.${key}` : key}"`;
		}
		// Null deletes the key whatever its declared type: a deletion is
		// typeless, so there is nothing to validate.
		if (obj[key] === null) continue;
		const sub = properties[key];
		if (sub === undefined) {
			const addl = schema.additionalProperties;
			if (addl === false) return `unknown state key "${path ? `${path}.${key}` : key}"`;
			// A schema in additionalProperties types the undeclared member like
			// a declared key (the knowledge bag, ADR 0006). True or absent stays
			// open: the member's subtree is walked by no schema, so the banned
			// shapes are enforced here directly.
			if (isPlainObject(addl)) {
				const error = validateValue(obj[key], addl, path ? `${path}.${key}` : key);
				if (error !== null) return error;
				continue;
			}
			const error = checkDeepPatch(obj[key], path ? `${path}.${key}` : key);
			if (error !== null) return error;
			continue;
		}
		const error = validateValue(obj[key], sub, path ? `${path}.${key}` : key);
		if (error !== null) return error;
	}
	return null;
}

// Rejects, at every depth of a value no schema walks: prototype-hazard keys.
// Operator-shaped objects are legal data below the patch root (ADR 0004):
// only the root operator walk reads $append and $remove. Objects
// recursively, arrays element-wise, everything else is safe.
function checkDeepPatch(value: unknown, path: string): string | null {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const error = checkDeepPatch(value[i], `${path}[${i}]`);
			if (error !== null) return error;
		}
		return null;
	}
	if (!isPlainObject(value)) return null;
	for (const key of Object.keys(value)) {
		if (isHazardKey(key)) {
			return `invalid state key "${path}.${key}"`;
		}
		const error = checkDeepPatch(value[key], `${path}.${key}`);
		if (error !== null) return error;
	}
	return null;
}

function validateValue(value: unknown, schema: JsonSchema, path: string): string | null {
	switch (schema.type) {
		// A subschema with no type constrains nothing but still bans the
		// shapes no schema would catch inside the value it admits unchecked.
		// Key-level nulls never reach here: validateObject resolves them as
		// deletions, so inside this function null is only ever a value — an
		// array element's null must satisfy the items schema like any other.
		case undefined:
			return checkDeepPatch(value, path);
		case "string": {
			const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
			return typeof value === "string" ? null : `state key "${path}" must be a string (was ${actual})`;
		}
		case "number": {
			const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
			return typeof value === "number" ? null : `state key "${path}" must be a number (was ${actual})`;
		}
		case "boolean": {
			const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
			return typeof value === "boolean" ? null : `state key "${path}" must be a boolean (was ${actual})`;
		}
		case "null":
			return value === null ? null : `state key "${path}" must be null`;
		case "array":
			if (!Array.isArray(value)) return `state key "${path}" must be an array`;
			if (schema.items !== undefined) {
				for (let i = 0; i < value.length; i++) {
					const error = validateValue(value[i], schema.items, `${path}[${i}]`);
					if (error !== null) return error;
				}
			} else {
				const error = checkDeepPatch(value, path);
				if (error !== null) return error;
			}
			return null;
		case "object":
			if (!isPlainObject(value)) return `state key "${path}" must be an object`;
			return validateObject(value, schema, path);
		// Anything else — an array-typed `type`, a bogus value in hand-written
		// JSON — is not a schema this runtime reads, and the patch must say so
		// instead of silently passing.
		default:
			return `unsupported schema type for "${path}"`;
	}
}

// Pure: never mutates t or patch. Untouched nested objects stay shared with t,
// which is safe because nothing downstream mutates state in place. The root
// flag gates the operator maps: they ride the patch root only (ADR 0004), so
// below it a $-prefixed key merges key-wise as plain data.
export function mergeState(t: ExecutionState, patch: ExecutionState, root = true): ExecutionState {
	const merged: ExecutionState = { ...t };
	for (const key of Object.keys(patch)) {
		const value = patch[key];
		if (root && (key === "$append" || key === "$remove")) {
			// Validation guarantees an operator target cannot collide with a
			// plain key.
			const map = value as ExecutionState;
			for (const target of Object.keys(map)) {
				// A missing or non-array current value starts from empty, so
				// $append initializes the key; an empty append on a key with no
				// array to grow is a no-op — it must not materialize an empty
				// array. $remove only touches an existing array, so a missing
				// key or a non-array value stays untouched and the op must not
				// materialize the key.
				const current: JsonValue[] = Array.isArray(t[target]) ? t[target] : [];
				if (key === "$append") {
					const appended = map[target] as JsonValue[];
					if (appended.length > 0 || current.length > 0) merged[target] = [...current, ...appended];
				} else {
					// Items match by deep value; untouched items keep their order
					// and share identity with the current array, so removing an
					// absent item is a no-op.
					const removals = map[target] as JsonValue[];
					const kept = current.filter((item) => !removals.some((gone) => jsonEquals(item, gone)));
					if (kept.length !== current.length) merged[target] = kept;
				}
			}
			continue;
		}
		if (value === null) {
			delete merged[key];
		} else if (isPlainObject(value)) {
			// Nested objects merge key-wise, and a key absent from t merges
			// against empty so a nested null under an absent parent deletes
			// into nothing instead of creating an object that holds nulls.
			const base = isPlainObject(t[key]) ? (t[key] as ExecutionState) : null;
			const nested = mergeState(base ?? {}, value as ExecutionState, false);
			if (base !== null || Object.keys(nested).length > 0) merged[key] = nested;
		} else {
			merged[key] = value;
		}
	}
	return merged;
}

// Atomic apply: on rejection the caller's own t is left untouched. changed is
// the structural-difference verdict, shared by every consumer.
export function applyPatch(t: ExecutionState, patch: unknown, schema: StateSchema): PatchApply {
	const error = validatePatch(patch, schema);
	if (error !== null) return { ok: false, error };
	const state = mergeState(t, patch as ExecutionState);
	return { ok: true, state, changed: !stateEquals(state, t) };
}

// The schema's volatile keys: the declared keys expected to change on most
// steps, which ride in the scratch state. An explicit x-state.volatile list
// wins, keeping its string entries. Without one, a heuristic protects the
// cache prefix: array-typed declared keys and the known planning keys are
// volatile, everything declared stays in the core.
export function volatileKeys(schema: StateSchema): string[] {
	const xState = schema["x-state"];
	if (isPlainObject(xState) && Array.isArray(xState.volatile)) {
		return xState.volatile.filter((key): key is string => typeof key === "string");
	}
	const properties = isPlainObject(schema.properties) ? schema.properties : {};
	const planningKeys = ["plan", "next_step", "findings", "open_questions", "scratch"];
	return Object.keys(properties).filter((key) => properties[key]?.type === "array" || planningKeys.includes(key));
}

// Splits the execution state into the two stored partitions (ADR 0003): a
// declared key outside the volatile set is state core; a volatile key or an
// undeclared key is scratch state, so a new key can never poison the core's
// cached bytes. Derives the volatile set itself, so callers need only the
// schema they already hold. Pure, and the partitions are disjoint by
// construction.
export function splitState(state: ExecutionState, schema: StateSchema): { core: ExecutionState; scratch: ExecutionState } {
	const volatile = volatileKeys(schema);
	const declared = Object.keys(schema.properties ?? {});
	const core: ExecutionState = {};
	const scratch: ExecutionState = {};
	for (const [key, value] of Object.entries(state)) {
		if (declared.includes(key) && !volatile.includes(key)) core[key] = value;
		else scratch[key] = value;
	}
	return { core, scratch };
}
