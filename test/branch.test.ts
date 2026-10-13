import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { SKILL_PROMPT_MESSAGE_TYPE, contentText, currentStepCut, scanBranch } from "../src/branch";
import { PROCEDURE_SPEC_MESSAGE_TYPE, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE, renderStateContent } from "../src/messages";
import type { ExecutionState } from "../src/state";

// Branch entries as the harness stores them; ids and timestamps are
// placeholders, only the shape matters to the reads under test.
let seq = 0;
const nextId = () => `e${seq++}`;
const stamp = () => new Date(0).toISOString();

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function invocation(name: string, attribution: "user" | "agent" = "user", details: unknown = { name }): SessionEntry {
	return {
		type: "custom_message",
		id: nextId(),
		parentId: null,
		timestamp: stamp(),
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content: `Running skill ${name}`,
		display: true,
		details,
		attribution,
	};
}

function specEntry(name: string): SessionEntry {
	return {
		type: "custom_message",
		id: nextId(),
		parentId: null,
		timestamp: stamp(),
		customType: PROCEDURE_SPEC_MESSAGE_TYPE,
		content: `Running skill ${name}`,
		display: false,
		details: { name },
	};
}

function stateEntry(customType: string, state: ExecutionState, details: unknown = { state }): SessionEntry {
	return {
		type: "custom_message",
		id: nextId(),
		parentId: null,
		timestamp: stamp(),
		customType,
		content: renderStateContent(state),
		display: true,
		details,
	};
}

const coreEntry = (state: ExecutionState, details: unknown = { state }) => stateEntry(STATE_CORE_MESSAGE_TYPE, state, details);
const scratchEntry = (state: ExecutionState, details: unknown = { state }) => stateEntry(STATE_SCRATCH_MESSAGE_TYPE, state, details);

// A stored state message of the retired single-state type, as a pre-split
// transcript carries it.
function legacyStateEntry(state: ExecutionState): SessionEntry {
	return stateEntry("sh.omp.skill-state.state", state);
}

function assistantEntry(id: string): SessionEntry {
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

function toolResultEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: stamp(),
		message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 },
	};
}

function customEntry(id: string): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: stamp(), customType: "tool_execution_start" };
}

describe("scanBranch", () => {
	test("an empty branch is inert", () => {
		expect(scanBranch([])).toBeUndefined();
	});

	test("a user invocation followed by its spec, a core and a scratch message re-derives the merged state", () => {
		const found = scanBranch([invocation("recon"), specEntry("recon"), coreEntry({ goal: "x", working_dir: "." }), scratchEntry({ plan: ["a"] })]);

		expect(found).toEqual({ name: "recon", spec: "Running skill recon", state: { goal: "x", working_dir: ".", plan: ["a"] } });
	});

	test("an empty scratch state still counts: the merged state is the core alone", () => {
		const found = scanBranch([invocation("recon"), specEntry("recon"), coreEntry({ goal: "x" }), scratchEntry({})]);

		expect(found).toEqual({ name: "recon", spec: "Running skill recon", state: { goal: "x" } });
	});

	test("the latest core and the latest scratch message win, each on its own type", () => {
		const found = scanBranch([
			invocation("recon"),
			specEntry("recon"),
			coreEntry({ goal: "old" }),
			coreEntry({ goal: "new" }),
			scratchEntry({ plan: ["old"] }),
			scratchEntry({ plan: ["new"] }),
		]);

		expect(found?.state).toEqual({ goal: "new", plan: ["new"] });
	});

	test("an incomplete head is inert: no spec, no core, or no scratch", () => {
		expect(scanBranch([invocation("recon"), scratchEntry({})])).toBeUndefined();
		expect(scanBranch([invocation("recon"), coreEntry({})])).toBeUndefined();
		expect(scanBranch([invocation("recon"), specEntry("recon")])).toBeUndefined();
		expect(scanBranch([invocation("recon"), specEntry("recon"), coreEntry({ goal: "x" })])).toBeUndefined();
		expect(scanBranch([invocation("recon"), specEntry("recon"), scratchEntry({ plan: [] })])).toBeUndefined();
	});

	test("a legacy single state message never completes the head", () => {
		expect(scanBranch([invocation("recon"), specEntry("recon"), legacyStateEntry({ goal: "x" })])).toBeUndefined();
		expect(scanBranch([invocation("recon"), specEntry("recon"), coreEntry({ goal: "x" }), legacyStateEntry({ stray: 1 })])).toBeUndefined();
	});

	test("a later invocation restarts the procedure: the earlier head is not attributed to it", () => {
		const branch = [invocation("recon"), specEntry("recon"), coreEntry({ goal: "old" }), scratchEntry({}), invocation("other")];
		expect(scanBranch(branch)).toBeUndefined();

		const found = scanBranch([...branch, specEntry("other"), coreEntry({ goal: "new" }), scratchEntry({})]);
		expect(found).toEqual({ name: "other", spec: "Running skill other", state: { goal: "new" } });
	});

	test("an agent-attributed invocation and one without a name never count", () => {
		const head = [specEntry("recon"), coreEntry({ goal: "x" }), scratchEntry({})];
		expect(scanBranch([invocation("recon", "agent"), ...head])).toBeUndefined();
		expect(scanBranch([invocation("recon", "user", {}), ...head])).toBeUndefined();
		expect(scanBranch([invocation("recon", "user", { name: "" }), ...head])).toBeUndefined();
	});

	test("head messages before any invocation are ignored", () => {
		expect(scanBranch([specEntry("recon"), coreEntry({ goal: "x" }), scratchEntry({}), invocation("recon")])).toBeUndefined();
	});

	test("only a plain-object details.state counts, for core and scratch alike", () => {
		const head = [invocation("recon"), specEntry("recon")];

		expect(scanBranch([...head, stateEntry(STATE_CORE_MESSAGE_TYPE, { goal: "x" }, {}), scratchEntry({})])).toBeUndefined();
		expect(scanBranch([...head, coreEntry({ goal: "x" }, { state: ["x"] }), scratchEntry({})])).toBeUndefined();
		expect(scanBranch([...head, coreEntry({ goal: "x" }), stateEntry(STATE_SCRATCH_MESSAGE_TYPE, {}, { state: null })])).toBeUndefined();
		expect(scanBranch([...head, coreEntry({ goal: "x" }), stateEntry(STATE_SCRATCH_MESSAGE_TYPE, {}, "no details")])).toBeUndefined();
	});

	test("entries of other kinds are skipped", () => {
		const found = scanBranch([
			customEntry("c1"),
			invocation("recon"),
			assistantEntry("a1"),
			specEntry("recon"),
			toolResultEntry("r1"),
			coreEntry({ goal: "x" }),
			toolResultEntry("r2"),
			scratchEntry({ plan: ["a"] }),
			customEntry("c2"),
		]);

		expect(found?.state).toEqual({ goal: "x", plan: ["a"] });
	});
});

describe("currentStepCut", () => {
	test("is the latest assistant message, even when results and customs follow it", () => {
		const cut = currentStepCut([
			assistantEntry("a1"),
			toolResultEntry("r1"),
			assistantEntry("a2"),
			customEntry("c1"),
			toolResultEntry("r2"),
			scratchEntry({}),
		]);

		expect(cut).toBe("a2");
	});

	test("is undefined when the branch holds no assistant message", () => {
		expect(currentStepCut([])).toBeUndefined();
		expect(currentStepCut([invocation("recon"), specEntry("recon"), coreEntry({}), scratchEntry({})])).toBeUndefined();
	});
});

describe("contentText", () => {
	test("a string passes through", () => {
		expect(contentText("body")).toBe("body");
	});

	test("text blocks join with newlines and other blocks are skipped", () => {
		const blocks = [{ type: "text", text: "a" }, { type: "image", data: "x", mimeType: "image/png" }, { type: "text", text: "b" }];

		expect(contentText(blocks)).toBe("a\nb");
	});

	test("anything else is stringified", () => {
		expect(contentText(42)).toBe("42");
	});
});
