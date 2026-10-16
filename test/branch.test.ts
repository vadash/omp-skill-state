import { describe, expect, test } from "bun:test";
import type { CustomMessagePayload, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { contentText, currentStepCut, scanBranch, stateMirrors, statePairs } from "../src/branch";
import { STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE } from "../src/messages";
import type { StateMirror } from "../src/messages";
import { commitStep, headMessages, newProcedure, stateMessages } from "../src/procedure";
import { DEFAULT_PARAMS } from "../src/state";
import type { ExecutionState, StateSchema } from "../src/state";
import { assistantEntry, coreStateEntry, invocationEntry, mirrorEntry, scratchStateEntry, specEntry, stateEntry } from "./entries";

let seq = 0;
const nextId = () => `e${seq++}`;

function toolResultEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 },
	};
}

function customEntry(id: string): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: new Date(0).toISOString(), customType: "tool_execution_start" };
}

describe("scanBranch", () => {
	test("an empty branch is inert", () => {
		expect(scanBranch([])).toBeUndefined();
	});

	test("a user invocation followed by its spec, a core and a scratch message re-derives the merged state", () => {
		const found = scanBranch([invocationEntry("recon"), specEntry("recon"), coreStateEntry({ goal: "x", working_dir: "." }), scratchStateEntry({ plan: ["a"] })]);

		expect(found).toEqual({ name: "recon", spec: "Running skill recon", state: { goal: "x", working_dir: ".", plan: ["a"] }, needsRepair: false, stamp: 0 });
	});

	test("an empty scratch state still counts: the merged state is the core alone", () => {
		const found = scanBranch([invocationEntry("recon"), specEntry("recon"), coreStateEntry({ goal: "x" }), scratchStateEntry({})]);

		expect(found).toEqual({ name: "recon", spec: "Running skill recon", state: { goal: "x" }, needsRepair: false, stamp: 0 });
	});

	test("the latest complete pair wins: a re-sent head supersedes the earlier one", () => {
		const found = scanBranch([
			invocationEntry("recon"),
			specEntry("recon"),
			coreStateEntry({ goal: "x" }),
			scratchStateEntry({ plan: ["old"] }),
			coreStateEntry({ goal: "x" }),
			scratchStateEntry({ plan: ["new"] }),
		]);

		expect(found?.state).toEqual({ goal: "x", plan: ["new"] });
	});

	test("an incomplete head is inert: no spec, no core, or no scratch", () => {
		expect(scanBranch([invocationEntry("recon"), scratchStateEntry({})])).toBeUndefined();
		expect(scanBranch([invocationEntry("recon"), coreStateEntry({})])).toBeUndefined();
		expect(scanBranch([invocationEntry("recon"), specEntry("recon")])).toBeUndefined();
		expect(scanBranch([invocationEntry("recon"), specEntry("recon"), coreStateEntry({ goal: "x" })])).toBeUndefined();
		expect(scanBranch([invocationEntry("recon"), specEntry("recon"), scratchStateEntry({ plan: [] })])).toBeUndefined();
	});

	test("a legacy single state message never completes the head", () => {
		// stateEntry with the retired single-state type, as a pre-split transcript carries it.
		expect(scanBranch([invocationEntry("recon"), specEntry("recon"), stateEntry("sh.omp.skill-state.state", { goal: "x" })])).toBeUndefined();
		expect(scanBranch([invocationEntry("recon"), specEntry("recon"), coreStateEntry({ goal: "x" }), stateEntry("sh.omp.skill-state.state", { stray: 1 })])).toBeUndefined();
	});

	test("a later invocation restarts the procedure: the earlier head is not attributed to it", () => {
		const branch = [invocationEntry("recon"), specEntry("recon"), coreStateEntry({ goal: "old" }), scratchStateEntry({}), invocationEntry("other")];
		expect(scanBranch(branch)).toBeUndefined();

		const found = scanBranch([...branch, specEntry("other"), coreStateEntry({ goal: "new" }), scratchStateEntry({})]);
		expect(found).toEqual({ name: "other", spec: "Running skill other", state: { goal: "new" }, needsRepair: false, stamp: 0 });
	});

	test("an agent-attributed invocation and one without a name never count", () => {
		const head = [specEntry("recon"), coreStateEntry({ goal: "x" }), scratchStateEntry({})];
		expect(scanBranch([invocationEntry("recon", "agent"), ...head])).toBeUndefined();
		expect(scanBranch([invocationEntry("recon", "user", {}), ...head])).toBeUndefined();
		expect(scanBranch([invocationEntry("recon", "user", { name: "" }), ...head])).toBeUndefined();
	});

	test("head messages before any invocation are ignored", () => {
		expect(scanBranch([specEntry("recon"), coreStateEntry({ goal: "x" }), scratchStateEntry({}), invocationEntry("recon")])).toBeUndefined();
	});

	test("only a plain-object details.state counts, for core and scratch alike", () => {
		const head = [invocationEntry("recon"), specEntry("recon")];

		expect(scanBranch([...head, stateEntry(STATE_CORE_MESSAGE_TYPE, { goal: "x" }, {}), scratchStateEntry({})])).toBeUndefined();
		expect(scanBranch([...head, coreStateEntry({ goal: "x" }, { state: ["x"] }), scratchStateEntry({})])).toBeUndefined();
		expect(scanBranch([...head, coreStateEntry({ goal: "x" }), stateEntry(STATE_SCRATCH_MESSAGE_TYPE, {}, { state: null })])).toBeUndefined();
		expect(scanBranch([...head, coreStateEntry({ goal: "x" }), stateEntry(STATE_SCRATCH_MESSAGE_TYPE, {}, "no details")])).toBeUndefined();
	});

	test("a damaged or trailing state message means inert, never a fallback to an earlier pair", () => {
		// The latest pair's scratch, replaced by an elide-pass placeholder: the
		// stale earlier pair must not re-engage (spec section 14: no head, stay inert).
		expect(
			scanBranch([
				invocationEntry("recon"),
				specEntry("recon"),
				coreStateEntry({ goal: "x" }),
				scratchStateEntry({}),
				coreStateEntry({ goal: "y" }),
				stateEntry(STATE_SCRATCH_MESSAGE_TYPE, {}, {}),
			]),
		).toBeUndefined();
		// A core whose scratch never landed.
		expect(scanBranch([invocationEntry("recon"), specEntry("recon"), coreStateEntry({ goal: "x" }), scratchStateEntry({}), coreStateEntry({ goal: "y" })])).toBeUndefined();
		// An orphan scratch after complete pairs.
		expect(scanBranch([invocationEntry("recon"), specEntry("recon"), coreStateEntry({ goal: "x" }), scratchStateEntry({}), scratchStateEntry({ stray: 1 })])).toBeUndefined();
		// A broken payload in the only pair.
		expect(scanBranch([invocationEntry("recon"), specEntry("recon"), coreStateEntry({ goal: "x" }), stateEntry(STATE_SCRATCH_MESSAGE_TYPE, {}, "no details")])).toBeUndefined();
	});

	test("entries of other kinds are skipped", () => {
		const found = scanBranch([
			customEntry("c1"),
			invocationEntry("recon"),
			assistantEntry("a1"),
			specEntry("recon"),
			toolResultEntry("r1"),
			coreStateEntry({ goal: "x" }),
			toolResultEntry("r2"),
			scratchStateEntry({ plan: ["a"] }),
			customEntry("c2"),
		]);

		expect(found?.state).toEqual({ goal: "x", plan: ["a"] });
	});

	test("the newest mirror re-derives its state and seeds its stamp, with repair when the stored pair is older", () => {
		// A crash between the mirror and its pair's boundary flush: the mirror
		// (stamp 1) is the state, the stored pair (stamp 0) is what the head
		// shows, so the disagreement is repaired by re-sending the head.
		const found = scanBranch([
			invocationEntry("recon"),
			specEntry("recon"),
			coreStateEntry({ goal: "stored" }),
			scratchStateEntry({}),
			mirrorEntry({ core: { goal: "mirror" }, scratch: { extra: 1 }, stamp: 4 }),
		]);

		expect(found).toEqual({ name: "recon", spec: "Running skill recon", state: { goal: "mirror", extra: 1 }, needsRepair: true, stamp: 4 });
	});

	test("a mirror that agrees with the newest stored pair re-derives without repair", () => {
		const found = scanBranch([
			invocationEntry("recon"),
			specEntry("recon"),
			coreStateEntry({ goal: "x" }, { state: { goal: "x" }, stamp: 1 }),
			scratchStateEntry({}, { state: {}, stamp: 1 }),
			mirrorEntry({ core: { goal: "x" }, scratch: {}, stamp: 1 }),
		]);

		expect(found).toEqual({ name: "recon", spec: "Running skill recon", state: { goal: "x" }, needsRepair: false, stamp: 1 });
	});

	test("a stored message whose content was rewritten behind the mirror's back is repaired", () => {
		// The elide pass rewrites content in place; a surviving details.state
		// with replaced content is exactly the disagreement ADR 0012 names.
		const tamperedCore = { ...coreStateEntry({ goal: "x" }, { state: { goal: "x" }, stamp: 1 }), content: "an elide-pass placeholder" };

		expect(scanBranch([invocationEntry("recon"), specEntry("recon"), tamperedCore, scratchStateEntry({}, { state: {}, stamp: 1 }), mirrorEntry({ core: { goal: "x" }, scratch: {}, stamp: 1 })])?.needsRepair).toBe(true);
	});

	test("a parked older-stamped pair after a newer pair does not time-travel the re-derive", () => {
		const found = scanBranch([
			invocationEntry("recon"),
			specEntry("recon"),
			coreStateEntry({ goal: "new" }, { state: { goal: "new" }, stamp: 2 }),
			scratchStateEntry({}, { state: {}, stamp: 2 }),
			// A parked next-turn send of the older commit, flushed late.
			coreStateEntry({ goal: "old" }, { state: { goal: "old" }, stamp: 1 }),
			scratchStateEntry({}, { state: {}, stamp: 1 }),
		]);

		expect(found?.state).toEqual({ goal: "new" });
		expect(found?.stamp).toBe(2);
	});

	test("equal stamps fall back to branch position", () => {
		const found = scanBranch([
			invocationEntry("recon"),
			specEntry("recon"),
			coreStateEntry({ goal: "old" }, { state: { goal: "old" }, stamp: 1 }),
			scratchStateEntry({}, { state: {}, stamp: 1 }),
			coreStateEntry({ goal: "new" }, { state: { goal: "new" }, stamp: 1 }),
			scratchStateEntry({}, { state: {}, stamp: 1 }),
		]);

		expect(found?.state).toEqual({ goal: "new" });
	});

	test("a mirror never resurrects an incomplete head", () => {
		expect(scanBranch([invocationEntry("recon"), specEntry("recon"), mirrorEntry({ core: { goal: "x" }, scratch: {}, stamp: 1 })])).toBeUndefined();
		expect(scanBranch([invocationEntry("recon"), mirrorEntry({ core: { goal: "x" }, scratch: {}, stamp: 1 }), coreStateEntry({ goal: "x" }), scratchStateEntry({})])).toBeUndefined();
	});
});

describe("stateMirrors", () => {
	test("reads the mirror entries in order and skips invalid payloads and other entries", () => {
		const mirrors = stateMirrors([
			invocationEntry("recon"),
			mirrorEntry({ core: { goal: "x" }, scratch: {}, stamp: 1 }),
			mirrorEntry({ core: {}, scratch: {}, stamp: "no" } as unknown as StateMirror),
			mirrorEntry("garbage" as unknown as StateMirror),
			assistantEntry("a1"),
			customEntry("c1"),
			mirrorEntry({ core: { goal: "y" }, scratch: { plan: ["a"] }, stamp: 2 }),
		]);

		expect(mirrors).toEqual([
			{ core: { goal: "x" }, scratch: {}, stamp: 1 },
			{ core: { goal: "y" }, scratch: { plan: ["a"] }, stamp: 2 },
		]);
	});

	test("a branch without mirror entries has none", () => {
		expect(stateMirrors([invocationEntry("recon"), specEntry("recon"), coreStateEntry({ goal: "x" }), scratchStateEntry({})])).toEqual([]);
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
			scratchStateEntry({}),
		]);

		expect(cut).toBe("a2");
	});

	test("is undefined when the branch holds no assistant message", () => {
		expect(currentStepCut([])).toBeUndefined();
		expect(currentStepCut([invocationEntry("recon"), specEntry("recon"), coreStateEntry({}), scratchStateEntry({})])).toBeUndefined();
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
		const pairs = statePairs([coreStateEntry({ goal: "x" }), scratchStateEntry({ plan: ["a"] }), coreStateEntry({ goal: "y" }), scratchStateEntry({ plan: ["b"] })]);

		expect(pairs).toEqual([
			{ core: { goal: "x" }, scratch: { plan: ["a"] } },
			{ core: { goal: "y" }, scratch: { plan: ["b"] } },
		]);
	});

	test("a branch with no state messages has no pairs", () => {
		expect(statePairs([])).toEqual([]);
		expect(statePairs([invocationEntry("recon"), specEntry("recon")])).toEqual([]);
	});

	test("an orphan scratch, a trailing open core and an unextractable payload yield no pair", () => {
		expect(statePairs([scratchStateEntry({ plan: [] })])).toEqual([]);
		expect(statePairs([coreStateEntry({ goal: "x" })])).toEqual([]);
		expect(statePairs([stateEntry(STATE_CORE_MESSAGE_TYPE, { goal: "x" }, {}), scratchStateEntry({})])).toEqual([]);
		expect(statePairs([coreStateEntry({ goal: "x" }), stateEntry(STATE_SCRATCH_MESSAGE_TYPE, {}, { state: null })])).toEqual([]);
	});

	test("a broken partition kills its pair only: later pairs still read", () => {
		const pairs = statePairs([
			coreStateEntry({ goal: "x" }),
			stateEntry(STATE_SCRATCH_MESSAGE_TYPE, {}, {}),
			coreStateEntry({ goal: "y" }),
			scratchStateEntry({ plan: ["b"] }),
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
					timestamp: new Date(0).toISOString(),
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
