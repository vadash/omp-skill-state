import { readFile } from "node:fs/promises";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { Skill } from "@oh-my-pi/pi-coding-agent";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export type ExecutionState = Record<string, JsonValue>;

export interface JsonSchema {
	type?: "string" | "number" | "boolean" | "array" | "object" | "null";
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	additionalProperties?: boolean;
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

export const DEFAULT_PARAMS: StateParams = { observationBytes: 32768, observationWindow: 1, stateBytes: 0, idleSteps: 5, retries: 3 };

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
	return validateObject(patch, schema, "");
}

// The keys whose assignment would reach the object's prototype machinery
// instead of its own properties. Banned from the state at every depth.
function isHazardKey(key: string): boolean {
	return key === "__proto__" || key === "constructor" || key === "prototype";
}

function validateObject(obj: Record<string, unknown>, schema: JsonSchema, path: string): string | null {
	const properties = isPlainObject(schema.properties) ? schema.properties : {};
	for (const key of Object.keys(obj)) {
		if (isHazardKey(key)) {
			return `invalid state key "${path ? `${path}.${key}` : key}"`;
		}
		// Null deletes the key whatever its declared type: a deletion is
		// typeless, so there is nothing to validate.
		if (obj[key] === null) continue;
		const sub = properties[key];
		if (sub === undefined) {
			// additionalProperties defaults to open, so only an explicit false rejects.
			if (schema.additionalProperties === false) return `unknown state key "${path ? `${path}.${key}` : key}"`;
			// An undeclared value's subtree is walked by no schema, so the
			// banned shapes are enforced here directly.
			const error = checkDeepPatch(obj[key], path ? `${path}.${key}` : key);
			if (error !== null) return error;
			continue;
		}
		const error = validateValue(obj[key], sub, path ? `${path}.${key}` : key);
		if (error !== null) return error;
	}
	return null;
}

// Rejects, at every depth of a value no schema walks: prototype-hazard keys,
// and $append objects whose payload is not an array (the operator is only
// legal against array keys, and a malformed one must never merge literally).
// Objects recursively, arrays element-wise, everything else is safe.
function checkDeepPatch(value: unknown, path: string): string | null {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const error = checkDeepPatch(value[i], `${path}[${i}]`);
			if (error !== null) return error;
		}
		return null;
	}
	if (!isPlainObject(value)) return null;
	if ("$append" in value && !Array.isArray(value.$append)) return `state key "${path}.$append" must be an array of items`;
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
		case "string":
			return typeof value === "string" ? null : `state key "${path}" must be a string`;
		case "number":
			return typeof value === "number" ? null : `state key "${path}" must be a number`;
		case "boolean":
			return typeof value === "boolean" ? null : `state key "${path}" must be a boolean`;
		case "null":
			return value === null ? null : `state key "${path}" must be null`;
		case "array": {
			// The $append operator mutates an array semantically: only the
			// appended items are validated, against the items schema.
			if (isAppendOp(value)) {
				// Extra members riding the op would be silently dropped by the
				// merge, so the op object must carry nothing but $append.
				if (Object.keys(value).length !== 1) return `state key "${path}" must be an array or an object carrying only $append`;
				if (schema.items !== undefined) {
					for (let i = 0; i < value.$append.length; i++) {
						const error = validateValue(value.$append[i], schema.items, `${path}.$append[${i}]`);
						if (error !== null) return error;
					}
				} else {
					const error = checkDeepPatch(value.$append, `${path}.$append`);
					if (error !== null) return error;
				}
				return null;
			}
			if (!Array.isArray(value)) {
				if (isPlainObject(value) && "$append" in value) return `state key "${path}.$append" must be an array of items`;
				return `state key "${path}" must be an array`;
			}
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
		}
		case "object":
			// $append is an array operator: only array keys can take it, so an
			// object key rejects it here and the merge never sees this shape.
			if (isAppendOp(value)) return `state key "${path}" does not accept $append`;
			if (!isPlainObject(value)) return `state key "${path}" must be an object`;
			return validateObject(value, schema, path);
		// Anything else — an array-typed `type`, a bogus value in hand-written
		// JSON — is not a schema this runtime reads, and the patch must say so
		// instead of silently passing.
		default:
			return `unsupported schema type for "${path}"`;
	}
}

// The $append patch operator: appends items to an array key instead of
// setting the array whole. Only the $append member is meaningful; a payload
// that is not an array of values is not an append op.
function isAppendOp(value: unknown): value is { $append: unknown[] } {
	return isPlainObject(value) && "$append" in value && Array.isArray(value.$append);
}

// Pure: never mutates t or patch. Untouched nested objects stay shared with t,
// which is safe because nothing downstream mutates state in place.
export function mergeState(t: ExecutionState, patch: ExecutionState): ExecutionState {
	const merged: ExecutionState = { ...t };
	for (const key of Object.keys(patch)) {
		const value = patch[key];
		if (value === null) {
			delete merged[key];
		} else if (isAppendOp(value)) {
			// A missing or non-array current value starts from empty, so $append
			// initializes the key; an empty append on a key with no array to
			// grow is a no-op — it must not materialize an empty array.
			const current: JsonValue[] = Array.isArray(t[key]) ? t[key] : [];
			// Items were validated against the schema's items in validateValue,
			// and a patch only ever arrives as JSON, so each item is a JsonValue.
			const appended = value.$append as JsonValue[];
			if (appended.length > 0 || current.length > 0) merged[key] = [...current, ...appended];
		} else if (isPlainObject(value)) {
			// Nested objects merge key-wise, and a key absent from t merges
			// against empty so a nested null under an absent parent deletes
			// into nothing instead of creating an object that holds nulls.
			const base = isPlainObject(t[key]) ? (t[key] as ExecutionState) : null;
			const nested = mergeState(base ?? {}, value as ExecutionState);
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

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
