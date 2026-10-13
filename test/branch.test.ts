import { describe, expect, test } from "bun:test";
import type { CustomMessagePayload, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { contentText, currentStepCut, scanBranch, statePairs } from "../src/branch";
import { PROCEDURE_SPEC_MESSAGE_TYPE, SKILL_PROMPT_MESSAGE_TYPE, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE, renderStateContent } from "../src/messages";
import { commitStep, headMessages, newProcedure, stateMessages } from "../src/procedure";
import { DEFAULT_PARAMS } from "../src/state";
import type { ExecutionState, StateSchema } from "../src/state";

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

	test("the latest complete pair wins: a re-sent head supersedes the earlier one", () => {
		const found = scanBranch([
			invocation("recon"),
			specEntry("recon"),
			coreEntry({ goal: "x" }),
			scratchEntry({ plan: ["old"] }),
			coreEntry({ goal: "x" }),
			scratchEntry({ plan: ["new"] }),
		]);

		expect(found?.state).toEqual({ goal: "x", plan: ["new"] });
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

	test("a damaged or trailing state message means inert, never a fallback to an earlier pair", () => {
		// The latest pair's scratch, replaced by an elide-pass placeholder: the
		// stale earlier pair must not re-engage (spec section 14: no head, stay inert).
		expect(
			scanBranch([
				invocation("recon"),
				specEntry("recon"),
				coreEntry({ goal: "x" }),
				scratchEntry({}),
				coreEntry({ goal: "y" }),
				stateEntry(STATE_SCRATCH_MESSAGE_TYPE, {}, {}),
			]),
		).toBeUndefined();
		// A core whose scratch never landed.
		expect(scanBranch([invocation("recon"), specEntry("recon"), coreEntry({ goal: "x" }), scratchEntry({}), coreEntry({ goal: "y" })])).toBeUndefined();
		// An orphan scratch after complete pairs.
		expect(scanBranch([invocation("recon"), specEntry("recon"), coreEntry({ goal: "x" }), scratchEntry({}), scratchEntry({ stray: 1 })])).toBeUndefined();
		// A broken payload in the only pair.
		expect(scanBranch([invocation("recon"), specEntry("recon"), coreEntry({ goal: "x" }), stateEntry(STATE_SCRATCH_MESSAGE_TYPE, {}, "no details")])).toBeUndefined();
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

describe("statePairs", () => {
	test("returns every stored pair in order: a scratch closes the pair its preceding core opened", () => {
		const pairs = statePairs([coreEntry({ goal: "x" }), scratchEntry({ plan: ["a"] }), coreEntry({ goal: "y" }), scratchEntry({ plan: ["b"] })]);

		expect(pairs).toEqual([
			{ core: { goal: "x" }, scratch: { plan: ["a"] } },
			{ core: { goal: "y" }, scratch: { plan: ["b"] } },
		]);
	});

	test("a branch with no state messages has no pairs", () => {
		expect(statePairs([])).toEqual([]);
		expect(statePairs([invocation("recon"), specEntry("recon")])).toEqual([]);
	});

	test("an orphan scratch, a trailing open core and an unextractable payload yield no pair", () => {
		expect(statePairs([scratchEntry({ plan: [] })])).toEqual([]);
		expect(statePairs([coreEntry({ goal: "x" })])).toEqual([]);
		expect(statePairs([stateEntry(STATE_CORE_MESSAGE_TYPE, { goal: "x" }, {}), scratchEntry({})])).toEqual([]);
		expect(statePairs([coreEntry({ goal: "x" }), stateEntry(STATE_SCRATCH_MESSAGE_TYPE, {}, { state: null })])).toEqual([]);
	});

	test("a broken partition kills its pair only: later pairs still read", () => {
		const pairs = statePairs([
			coreEntry({ goal: "x" }),
			stateEntry(STATE_SCRATCH_MESSAGE_TYPE, {}, {}),
			coreEntry({ goal: "y" }),
			scratchEntry({ plan: ["b"] }),
		]);

		expect(pairs).toEqual([{ core: { goal: "y" }, scratch: { plan: ["b"] } }]);
	});

	test("the stored head and commit asides read back as the committed states", () => {
		// The writer→reader round-trip: the runtime's own payloads, stored as
		// the harness stores them, read back through the pairing rule. The two
		// conversions must agree, so they share this local fixture.
		const asEntries = (payloads: readonly CustomMessagePayload[]): SessionEntry[] =>
			payloads.map((payload) => {
				// The runtime's builders always set these; anything less is not a
				// state message and fails loudly here rather than storing junk.
				if (typeof payload !== "object" || payload.customType === undefined || payload.content === undefined || payload.display === undefined) throw new Error("not a runtime-built payload");
				return {
					type: "custom_message" as const,
					id: nextId(),
					parentId: null,
					timestamp: stamp(),
					customType: payload.customType,
					content: payload.content,
					display: payload.display,
					details: payload.details,
				};
			});
		const schema: StateSchema = { type: "object", properties: { goal: { type: "string" }, plan: { type: "array", items: { type: "string" } } } };
		const procedure = newProcedure("recon", "spec", schema, DEFAULT_PARAMS, { goal: "x", plan: ["a"] });

		const headEntries = asEntries(headMessages(procedure));
		expect(statePairs(headEntries)).toEqual([{ core: { goal: "x" }, scratch: { plan: ["a"] } }]);

		commitStep(procedure, { goal: "y", plan: ["a", "b"] });
		expect(statePairs([...headEntries, ...asEntries(stateMessages(procedure))])).toEqual([
			{ core: { goal: "x" }, scratch: { plan: ["a"] } },
			{ core: { goal: "y" }, scratch: { plan: ["a", "b"] } },
		]);
	});
});
