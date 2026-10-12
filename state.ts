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
	idleSteps: number;
	retries: number;
}

export const DEFAULT_PARAMS: StateParams = { observationBytes: 32768, idleSteps: 5, retries: 3 };

export type SchemaLoad =
	| { ok: true; schema: StateSchema; params: StateParams }
	| { ok: false; error: string };

export type PatchApply =
	| { ok: true; state: ExecutionState }
	| { ok: false; error: string };

// A missing or malformed schema is a returned failure, not a throw: a skill
// without a usable state.schema.json is an ordinary skill and must stay silent.
export async function loadStateSchema(skillName: string, skills: readonly Skill[]): Promise<SchemaLoad> {
	try {
		const schemaPath = await InternalUrlRouter.instance().locate(`skill://${skillName}/state.schema.json`, { skills });
		if (schemaPath === null) return { ok: false, error: `no state.schema.json for skill "${skillName}"` };
		const parsed: unknown = JSON.parse(await readFile(schemaPath, "utf8"));
		if (!isPlainObject(parsed)) return { ok: false, error: `state.schema.json for "${skillName}" is not a JSON object` };
		const schema = parsed as StateSchema;
		return { ok: true, schema, params: readParams(schema["x-state"]) };
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
			if (!Array.isArray(value)) return `state key "${path}" must be an array`;
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
	}
}

// Pure: never mutates t or patch. Untouched nested objects stay shared with t,
// which is safe because nothing downstream mutates state in place.
export function mergeState(t: ExecutionState, patch: ExecutionState): ExecutionState {
	const merged: ExecutionState = { ...t };
	for (const key of Object.keys(patch)) {
		const value = patch[key];
		if (value === null) {
			delete merged[key];
		} else if (isPlainObject(value) && isPlainObject(t[key])) {
			merged[key] = mergeState(t[key] as ExecutionState, value as ExecutionState);
		} else {
			merged[key] = value;
		}
	}
	return merged;
}

// Atomic apply: on rejection the caller's own t is left untouched.
export function applyPatch(t: ExecutionState, patch: unknown, schema: StateSchema): PatchApply {
	const error = validatePatch(patch, schema);
	if (error !== null) return { ok: false, error };
	return { ok: true, state: mergeState(t, patch as ExecutionState) };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
