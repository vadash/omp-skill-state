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
		return parseStateSchema(JSON.parse(await readFile(schemaPath, "utf8")));
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

function validateObject(obj: Record<string, unknown>, schema: JsonSchema, path: string): string | null {
	const properties = isPlainObject(schema.properties) ? schema.properties : {};
	for (const key of Object.keys(obj)) {
		// Prototype-hazard keys never enter the state: a later assignment of
		// them would reach the object's prototype machinery, not its properties.
		if (key === "__proto__" || key === "constructor" || key === "prototype") {
			return `invalid state key "${path ? `${path}.${key}` : key}"`;
		}
		const sub = properties[key];
		if (sub === undefined) {
			// additionalProperties defaults to open, so only an explicit false rejects.
			if (schema.additionalProperties === false) return `unknown state key "${path ? `${path}.${key}` : key}"`;
			continue;
		}
		const error = validateValue(obj[key], sub, path ? `${path}.${key}` : key);
		if (error !== null) return error;
	}
	return null;
}

function validateValue(value: unknown, schema: JsonSchema, path: string): string | null {
	// Null is a typeless deletion operator across every schema type: the merge
	// removes the key, so no declared type can reject it (the operating rules
	// and the consolidation nudge both instruct exactly this).
	if (value === null) return null;
	switch (schema.type) {
		// A subschema with no type constrains nothing.
		case undefined:
			return null;
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
				if (schema.items !== undefined) {
					for (let i = 0; i < value.$append.length; i++) {
						const error = validateValue(value.$append[i], schema.items, `${path}.$append[${i}]`);
						if (error !== null) return error;
					}
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
			}
			return null;
		}
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
			// initializes the key; an empty append changes nothing.
			const current: JsonValue[] = Array.isArray(t[key]) ? t[key] : [];
			// Items were validated against the schema's items in validateValue,
			// and a patch only ever arrives as JSON, so each item is a JsonValue.
			const appended = value.$append as JsonValue[];
			merged[key] = [...current, ...appended];
		} else if (isPlainObject(value) && isPlainObject(t[key])) {
			merged[key] = mergeState(t[key] as ExecutionState, value as ExecutionState);
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
