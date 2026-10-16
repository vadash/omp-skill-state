import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { SKILL_PROMPT_MESSAGE_TYPE, STATE_CORE_MESSAGE_TYPE, STATE_MIRROR_ENTRY_TYPE, STATE_SCRATCH_MESSAGE_TYPE, renderStateContent, specMessage } from "../src/messages";
import type { StateMirror } from "../src/messages";
import type { ExecutionState } from "../src/state";

// Stored-branch entry builders, one home for the shape the fake session and
// the suites seed with. Ids and timestamps are placeholders; only the shape
// matters to the reads and seeds under test. Seed ids are deterministic
// (`seed-N`, unique per process); a builder whose id an assertion must name
// (assistantEntry, the compaction cut) takes one explicitly.

let seedSeq = 0;
const seedId = () => `seed-${++seedSeq}`;
const stamp = () => new Date(0).toISOString();

export const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function invocationEntry(name: string, attribution: "user" | "agent" = "user", details: unknown = { name }): SessionEntry {
	return {
		type: "custom_message",
		id: seedId(),
		parentId: null,
		timestamp: stamp(),
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content: `Running skill ${name}`,
		display: true,
		details,
		attribution,
	};
}

export function specEntry(name: string): SessionEntry {
	return {
		type: "custom_message",
		id: seedId(),
		parentId: null,
		timestamp: stamp(),
		...(specMessage({ spec: `Running skill ${name}`, name }) as { customType: string; content: string; display: boolean; details: { name: string } }),
	};
}

// The primitive the state builders apply: one stored custom message carrying
// a rendered partition.
export function stateEntry(customType: string, state: ExecutionState, details: unknown = { state }): SessionEntry {
	return {
		type: "custom_message",
		id: seedId(),
		parentId: null,
		timestamp: stamp(),
		customType,
		content: renderStateContent(state),
		display: true,
		details,
	};
}

export function coreStateEntry(state: ExecutionState, details: unknown = { state }): SessionEntry {
	return stateEntry(STATE_CORE_MESSAGE_TYPE, state, details);
}

export function scratchStateEntry(state: ExecutionState, details: unknown = { state }): SessionEntry {
	return stateEntry(STATE_SCRATCH_MESSAGE_TYPE, state, details);
}

// One stored state pair: the runtime commits a state as two messages, the
// state core first and the scratch state second. Seeding uses an all-core
// split with an empty scratch; a real run's partitions differ, but the head
// shape and the merged state are what the reads under test consume.
export function stateEntries(state: ExecutionState): SessionEntry[] {
	return [coreStateEntry(state), scratchStateEntry({})];
}

// The durable mirror of one commit (ADR 0012): the custom entry type the
// harness appends and never sends to the LLM.
export function mirrorEntry(mirror: StateMirror): SessionEntry {
	return { type: "custom", id: seedId(), parentId: null, timestamp: stamp(), customType: STATE_MIRROR_ENTRY_TYPE, data: mirror };
}

// What an engaged run leaves on the branch: the invocation, then the head
// asides, then one core+scratch pair per accepted patch.
export function procedureBranch(name: string, ...states: ExecutionState[]): SessionEntry[] {
	return [invocationEntry(name), specEntry(name), ...states.flatMap((state) => stateEntries(state))];
}

export function assistantEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: stamp(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "step" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: ZERO_USAGE,
			stopReason: "toolUse",
			timestamp: 0,
		},
	};
}

// The transcript file's fixed-width first line: the harness pads the title
// slot to exactly 256 UTF-8 bytes with spaces, so the line is valid JSON with
// trailing whitespace and a recall read must parse it or skip it, never crash.
export function titleSlotLine(title = "fixture transcript"): string {
	const slot = { type: "title", v: 1, title, updatedAt: stamp(), pad: "" };
	const pad = " ".repeat(256 - Buffer.byteLength(JSON.stringify(slot)));
	return JSON.stringify({ ...slot, pad });
}

// The raw transcript-line shape the recall read parses off disk: one message
// entry per JSON line, stamped with the same epoch instant as the builders
// above so either shape asserts identically.
export const transcriptStamp = stamp();

export function messageLine(role: string, content: unknown): string {
	return JSON.stringify({ type: "message", id: "e", parentId: null, timestamp: transcriptStamp, message: { role, content, timestamp: 0 } });
}
