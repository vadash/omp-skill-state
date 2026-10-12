import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { OPERATING_RULES, PROCEDURE_SPEC_MESSAGE_TYPE, RULES_MESSAGE_TYPE, stateMessage } from "./messages";
import { compactionFor, headMessages, newProcedure, noteProjected, recordReply } from "./procedure";
import type { Procedure, StepOutcome } from "./procedure";
import { DEFAULT_PARAMS } from "./state";
import type { ExecutionState, StateParams, StateSchema } from "./state";

const schema: StateSchema = { type: "object", properties: { goal: { type: "string" } } };

function procedure(params: Partial<StateParams> = {}, state: ExecutionState = {}): Procedure {
	return newProcedure("recon", "Running skill recon", schema, { ...DEFAULT_PARAMS, ...params }, state);
}

// A procedure whose latest prompt carried the head: the model saw the rules,
// so a step without a state edit is idle.
function projected(params: Partial<StateParams> = {}, state: ExecutionState = {}): Procedure {
	const p = procedure(params, state);
	noteProjected(p, true);
	return p;
}

// A patch always arrives as a state_update tool call, so a patch step is a
// tool-call step by construction.
const step = (patch: unknown) => ({ patch, hasPatch: true });
// A reply with no state_update call is an empty patch.
const empty = () => ({ hasPatch: false });

// Commits a store outcome the way the state_update execute does, for tests
// that read the record's state after the reply.
function commit(procedure: Procedure, outcome: StepOutcome): void {
	if (outcome.kind === "store") procedure.state = outcome.state;
}

function assistantEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "step" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 0,
		},
	};
}

describe("newProcedure", () => {
	test("starts with fresh counters and nothing pending", () => {
		expect(procedure()).toEqual({
			name: "recon",
			spec: "Running skill recon",
			schema,
			params: DEFAULT_PARAMS,
			state: {},
			invalidPatches: 0,
			idle: 0,
			projected: false,
		});
	});
});

describe("recordReply with a patch", () => {
	test("a valid patch merges into the store outcome and leaves the record's state untouched", () => {
		const p = procedure();

		const outcome = recordReply(p, step({ goal: "x" }));

		expect(outcome).toEqual({ kind: "store", state: { goal: "x" } });
		// The state_update execute commits; the policy only validates and merges.
		expect(p.state).toEqual({});
		expect(p.pendingError).toBeUndefined();
	});

	test("a patch argument that is not an object blocks with the shape error", () => {
		const p = procedure();

		expect(recordReply(p, step(undefined))).toEqual({ kind: "block" });
		expect(p.pendingError).toBe("state patch must be a JSON object");
	});

	test("a patch that leaves the state as it was stores nothing", () => {
		const p = procedure({}, { goal: "x" });

		expect(recordReply(p, step({ goal: "x" }))).toEqual({ kind: "none" });
		expect(p.state).toEqual({ goal: "x" });
	});

	test("no state_update call is an empty patch", () => {
		const p = procedure();

		expect(recordReply(p, empty())).toEqual({ kind: "none" });
		expect(p.state).toEqual({});
	});

	test("an invalid patch blocks the step and leaves the state untouched", () => {
		const p = procedure({}, { goal: "keep" });

		expect(recordReply(p, step({ goal: 42 }))).toEqual({ kind: "block" });
		expect(p.pendingError).toContain("goal");
		expect(p.state).toEqual({ goal: "keep" });
		expect(p.invalidPatches).toBe(1);
	});

	test("the next reply clears the pending error; a valid or empty one resets the counter", () => {
		const p = procedure();
		recordReply(p, step({ goal: 42 }));
		recordReply(p, step({ goal: "x" }));
		expect(p.pendingError).toBeUndefined();
		expect(p.invalidPatches).toBe(0);

		recordReply(p, step({ goal: 42 }));
		recordReply(p, empty());
		expect(p.pendingError).toBeUndefined();
		expect(p.invalidPatches).toBe(0);
	});

	test("the retries-th consecutive invalid patch degrades", () => {
		const p = procedure();
		expect(recordReply(p, step({ goal: 42 }))).toEqual({ kind: "block" });
		expect(recordReply(p, step({ goal: 42 }))).toEqual({ kind: "block" });

		expect(recordReply(p, step({ goal: 42 }))).toEqual({ kind: "ended", cause: "degrade" });
	});

	test("the degrade threshold honours x-state retries", () => {
		const p = procedure({ retries: 2 });
		expect(recordReply(p, step({ goal: 42 }))).toEqual({ kind: "block" });

		expect(recordReply(p, step({ goal: 42 }))).toEqual({ kind: "ended", cause: "degrade" });
	});

	test("a valid patch between failures resets the consecutive counter", () => {
		const p = procedure();
		recordReply(p, step({ goal: 42 }));
		recordReply(p, step({ goal: 42 }));
		recordReply(p, step({ goal: "x" }));
		recordReply(p, step({ goal: 42 }));

		expect(recordReply(p, step({ goal: 42 }))).toEqual({ kind: "block" });
	});
});

describe("recordReply and idle steps", () => {
	test("idle steps count only when the prompt carried the head", () => {
		const p = procedure();
		for (let i = 0; i < 3; i++) expect(recordReply(p, empty())).toEqual({ kind: "none" });
		expect(p.idle).toBe(0);

		noteProjected(p, true);
		expect(recordReply(p, empty())).toEqual({ kind: "none" });
		expect(recordReply(p, empty())).toEqual({ kind: "none" });
		expect(recordReply(p, empty())).toEqual({ kind: "ended", cause: "idle" });
	});

	test("the idle threshold honours x-state idleSteps", () => {
		const p = projected({ idleSteps: 2 });
		expect(recordReply(p, empty())).toEqual({ kind: "none" });

		expect(recordReply(p, empty())).toEqual({ kind: "ended", cause: "idle" });
	});

	test("an unchanged patch is an idle step too", () => {
		const p = projected({ idleSteps: 2 }, { goal: "x" });
		expect(recordReply(p, step({ goal: "x" }))).toEqual({ kind: "none" });

		expect(recordReply(p, step({ goal: "x" }))).toEqual({ kind: "ended", cause: "idle" });
	});

	test("a patch of any kind, valid or invalid, breaks an idle run", () => {
		const valid = projected();
		recordReply(valid, empty());
		recordReply(valid, empty());
		recordReply(valid, step({ goal: "x" }));
		expect(valid.idle).toBe(0);
		recordReply(valid, empty());
		expect(recordReply(valid, empty())).toEqual({ kind: "none" });

		const invalid = projected();
		recordReply(invalid, empty());
		recordReply(invalid, empty());
		recordReply(invalid, step({ goal: 42 }));
		expect(invalid.idle).toBe(0);
	});

	test("a step whose prompt lost the head pauses the count without resetting it", () => {
		const p = projected();
		recordReply(p, empty());
		noteProjected(p, false);
		recordReply(p, empty());
		expect(p.idle).toBe(1);

		noteProjected(p, true);
		recordReply(p, empty());
		expect(recordReply(p, empty())).toEqual({ kind: "ended", cause: "idle" });
	});
});

describe("headMessages", () => {
	test("headMessages is the rules, P and the state, in order and byte-equal across calls", () => {
		const p = procedure({}, { goal: "x" });

		const head = headMessages(p);

		expect(head).toEqual([
			{ customType: RULES_MESSAGE_TYPE, content: OPERATING_RULES, display: false },
			{ customType: PROCEDURE_SPEC_MESSAGE_TYPE, content: "Running skill recon", display: false, details: { name: "recon" } },
			stateMessage({ goal: "x" }),
		]);
		expect(headMessages(p)).toEqual(head);
	});

	test("the head follows an accepted patch", () => {
		const p = procedure();
		commit(p, recordReply(p, step({ goal: "x" })));

		expect(headMessages(p)[2]).toEqual(stateMessage({ goal: "x" }));
	});
});

describe("compactionFor", () => {
	const preparation = { firstKeptEntryId: "h1", tokensBefore: 4321 };

	test("summarises to the state, cuts at the current step and preserves the raw state", () => {
		const p = procedure({}, { goal: "g" });

		const result = compactionFor(p, preparation, [assistantEntry("a1"), assistantEntry("a2")]);

		expect(result).toEqual({
			compaction: {
				summary: `Execution state of procedure "recon" (skill-state runtime):\n\n${JSON.stringify({ goal: "g" }, null, 2)}`,
				shortSummary: 'skill-state: procedure "recon" execution state',
				firstKeptEntryId: "a2",
				tokensBefore: 4321,
				preserveData: { state: { goal: "g" } },
			},
		});
	});

	test("a branch with no assistant message falls back to the harness's cut", () => {
		expect(compactionFor(procedure(), preparation, []).compaction?.firstKeptEntryId).toBe("h1");
	});

	test("a later compaction carries the live state", () => {
		const p = procedure({}, { goal: "g" });
		commit(p, recordReply(p, step({ step: 2 })));

		expect(compactionFor(p, preparation, []).compaction?.preserveData).toEqual({ state: { goal: "g", step: 2 } });
	});
});
