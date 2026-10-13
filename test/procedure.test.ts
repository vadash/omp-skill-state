import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { OPERATING_RULES, PROCEDURE_SPEC_MESSAGE_TYPE, RULES_MESSAGE_TYPE, consolidationNudgeMessage, coreMessage, scratchMessage } from "../src/messages";
import { commitStep, compactionFor, headMessages, newProcedure, recordReply, stateMessages, stepPrompt } from "../src/procedure";
import type { Procedure } from "../src/procedure";
import { DEFAULT_PARAMS } from "../src/state";
import type { ExecutionState, StateParams, StateSchema } from "../src/state";
import type { AgentMessage } from "../src/types";

const schema: StateSchema = { type: "object", properties: { goal: { type: "string" } } };

function procedure(params: Partial<StateParams> = {}, state: ExecutionState = {}): Procedure {
	return newProcedure("recon", "Running skill recon", schema, { ...DEFAULT_PARAMS, ...params }, state);
}

// The head as the context event would carry it: the harness stores each sent
// payload as a custom message, adding the role envelope the projection reads.
function headContext(procedure: Procedure): AgentMessage[] {
	return headMessages(procedure).map((payload) => ({ role: "custom" as const, timestamp: Date.now(), ...(payload as object) })) as unknown as AgentMessage[];
}

// A procedure whose latest prompt carried the head: the model saw the rules,
// so a step without a state edit is idle. The flag is set the only way
// production sets it, through the stepPrompt seam.
function projected(params: Partial<StateParams> = {}, state: ExecutionState = {}): Procedure {
	const p = procedure(params, state);
	if (stepPrompt(p, headContext(p)) === undefined) throw new Error("head did not project");
	return p;
}

// A patch always arrives as a state_update tool call, so a patch step is a
// tool-call step by construction. A reply may carry several calls; their
// patches ride in declaration order.
const step = (...patches: unknown[]) => ({ patches, hasPatch: patches.length > 0 });
// A reply with no state_update call is an empty patch.
const empty = () => ({ patches: [], hasPatch: false });

// Commits an ok step the way the state_update executes do: one commitStep
// call per patch, in declaration order. Every test that reads the record's
// state after the reply walks the execute road, so the fold's verdict and the
// commits must land on the same state.
function commit(procedure: Procedure, reply: { patches: unknown[]; hasPatch: boolean }): void {
	if (!reply.hasPatch) return;
	for (const patch of reply.patches) {
		const committed = commitStep(procedure, patch);
		if ("error" in committed) throw new Error(`patch rejected: ${committed.error}`);
	}
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
			capNudged: false,
			projected: false,
			step: 0,
			nudgedAt: -1,
			nudgesMemo: [],
		});
	});
});

describe("recordReply with a patch", () => {
	test("a valid patch folds into an ok step and leaves the record's state untouched", () => {
		const p = procedure();

		const outcome = recordReply(p, step({ goal: "x" }));

		expect(outcome).toEqual({ kind: "ok" });
		// The state_update executes commit; the policy only validates and merges.
		expect(p.state).toEqual({});
		expect(p.pendingError).toBeUndefined();
	});

	test("a patch argument that is not an object blocks with the shape error", () => {
		const p = procedure();

		expect(recordReply(p, step(undefined))).toEqual({ kind: "block" });
		expect(p.pendingError).toBe("state patch must be a JSON object");
	});

	test("a patch that leaves the state as it was is an empty patch", () => {
		const p = procedure({}, { goal: "x" });

		expect(recordReply(p, step({ goal: "x" }))).toEqual({ kind: "none" });
		expect(p.state).toEqual({ goal: "x" });
	});

	test("no state_update call is an empty patch", () => {
		const p = procedure();

		expect(recordReply(p, empty())).toEqual({ kind: "none" });
		expect(p.state).toEqual({});
	});

	test("a null patch on an existing declared key clears it without blocking", () => {
		const p = procedure({}, { goal: "obsolete", kept: "yes" });

		const reply = step({ goal: null });
		expect(recordReply(p, reply)).toEqual({ kind: "ok" });
		expect(p.pendingError).toBeUndefined();
		commit(p, reply);
		expect(p.state).toEqual({ kept: "yes" });
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

	test("a batch of valid patches folds in order into one ok step", () => {
		const p = procedure({}, { findings: ["old"] });

		const reply = step({ findings: { $append: ["a"] } }, { next_step: "b" });
		expect(recordReply(p, reply)).toEqual({ kind: "ok" });
		expect(p.pendingError).toBeUndefined();
		expect(p.invalidPatches).toBe(0);

		// The execute road lands where the fold landed.
		commit(p, reply);
		expect(p.state).toEqual({ findings: ["old", "a"], next_step: "b" });
	});

	test("an invalid patch anywhere in a batch blocks the step with that patch's error", () => {
		const p = procedure();

		const outcome = recordReply(p, step({ goal: "x" }, { goal: 42 }));

		expect(outcome).toEqual({ kind: "block" });
		expect(p.pendingError).toContain('"goal"');
		expect(p.invalidPatches).toBe(1);
	});
});

describe("recordReply and idle steps", () => {
	test("idle steps count only when the prompt carried the head", () => {
		const p = procedure();
		for (let i = 0; i < 3; i++) expect(recordReply(p, empty())).toEqual({ kind: "none" });
		expect(p.idle).toBe(0);

		if (stepPrompt(p, headContext(p)) === undefined) throw new Error("head did not project");
		expect(recordReply(p, empty())).toEqual({ kind: "none" });
		expect(recordReply(p, empty())).toEqual({ kind: "none" });
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
		if (stepPrompt(p, []) !== undefined) throw new Error("headless prompt projected");
		recordReply(p, empty());
		expect(p.idle).toBe(1);

		if (stepPrompt(p, headContext(p)) === undefined) throw new Error("head did not project");
		recordReply(p, empty());
		recordReply(p, empty());
		recordReply(p, empty());
		expect(recordReply(p, empty())).toEqual({ kind: "ended", cause: "idle" });
	});
});

describe("commitStep", () => {
	test("moves the state, resets the idle counter, and hands back the two state messages to send", () => {
		const p = projected();
		recordReply(p, empty());
		recordReply(p, empty());
		expect(p.idle).toBe(2);

		const committed = commitStep(p, { goal: "x" });

		if ("error" in committed) throw new Error(committed.error);
		expect(committed.result).toBe("execution state updated");
		expect(committed.sends).toEqual(stateMessages(p));
		expect(p.state).toEqual({ goal: "x" });
		expect(p.idle).toBe(0);
	});

	test("an invalid patch returns the exact error and commits nothing", () => {
		const p = procedure({}, { goal: "keep" });

		const committed = commitStep(p, { goal: 42 });

		if ("result" in committed) throw new Error("invalid patch accepted");
		expect(committed.error).toContain("goal");
		expect(p.state).toEqual({ goal: "keep" });
	});

	test("a patch that changes nothing reports no change and sends nothing", () => {
		const p = procedure({}, { goal: "x" });

		expect(commitStep(p, { goal: "x" })).toEqual({ result: "no change to the execution state", sends: [] });
	});

	test("sequential per-call commits land where the fold landed, even across a change and its revert", () => {
		const fold = procedure({}, { goal: "x" });
		const calls = procedure({}, { goal: "x" });

		const reply = step({ goal: "y" }, { goal: "z" }, { goal: "x" });
		expect(recordReply(fold, reply)).toEqual({ kind: "ok" });

		commit(calls, reply);

		expect(calls.state).toEqual(fold.state);
		expect(fold.state).toEqual({ goal: "x" });
	});
});

describe("stepPrompt nudges", () => {
	// The tail a projected prompt carries beyond its head: the turn's nudges.
	function nudgesFor(procedure: Procedure): AgentMessage[] {
		const head = headContext(procedure);
		const out = stepPrompt(procedure, head);
		if (out === undefined) throw new Error("head did not project");
		return out.slice(head.length);
	}

	test("returns nothing while the state is under the cap and leaves the latch off", () => {
		const p = projected();

		expect(nudgesFor(p)).toEqual([]);
		expect(p.capNudged).toBe(false);
	});

	test("hands the consolidation nudge out once per over-cap episode and is idempotent within the step", () => {
		const p = projected({ stateBytes: 100 }, { blob: "x".repeat(200) });

		// The ask rode on the first projected prompt and latched.
		expect(nudgesFor(p)).toEqual([consolidationNudgeMessage()]);
		expect(p.capNudged).toBe(true);
		// A repeated call in the same step re-serves the same set, never a duplicate.
		expect(nudgesFor(p)).toEqual([consolidationNudgeMessage()]);

		// The next step re-evaluates: the latch holds, so nothing rides again.
		recordReply(p, empty());
		expect(nudgesFor(p)).toEqual([]);
	});

	test("re-arms when a commit lands the state back under the cap, and fires once more", () => {
		const p = projected({ stateBytes: 200 }, { blob: "x".repeat(200) });
		expect(nudgesFor(p)).toHaveLength(1);

		// The commit lands in a later step, the way the tool execute does it.
		const shrink = commitStep(p, { blob: "x" });
		if ("error" in shrink) throw new Error(shrink.error);
		recordReply(p, empty());
		expect(nudgesFor(p)).toEqual([]);
		expect(p.capNudged).toBe(false);

		const grow = commitStep(p, { blob: "x".repeat(200) });
		if ("error" in grow) throw new Error(grow.error);
		recordReply(p, empty());
		expect(nudgesFor(p)).toEqual([consolidationNudgeMessage()]);
	});

	test("the idle warning rides exactly at threshold minus one and resets with a patch", () => {
		const p = projected({ idleSteps: 3 });
		recordReply(p, empty());
		expect(nudgesFor(p)).toEqual([]);

		recordReply(p, empty());
		const nudged = nudgesFor(p);
		expect(nudged).toHaveLength(1);
		const [nudge] = nudged;
		if (nudge === undefined || !("content" in nudge) || typeof nudge.content !== "string") throw new Error("nudge without text content");
		expect(nudge.role).toBe("developer");
		expect(nudge.content).toContain("unchanged for 2 consecutive steps");

		recordReply(p, step({ goal: "x" }));
		expect(nudgesFor(p)).toEqual([]);
	});

	test("a fresh cap ask and the idle warning ride on the same step, consolidation first", () => {
		const p = projected({ stateBytes: 200, idleSteps: 3 }, { blob: "x".repeat(200) });
		expect(p.capNudged).toBe(true);

		// Under the cap the latch re-arms; over it again the ask is fresh, and
		// a commit resets the idle run.
		const shrink = commitStep(p, { blob: "x" });
		if ("error" in shrink) throw new Error(shrink.error);
		recordReply(p, empty());
		expect(nudgesFor(p)).toEqual([]);
		expect(p.capNudged).toBe(false);
		const grow = commitStep(p, { blob: "x".repeat(200) });
		if ("error" in grow) throw new Error(grow.error);

		// Two quiet projected steps bring idle to threshold minus one.
		recordReply(p, empty());
		recordReply(p, empty());

		const nudges = nudgesFor(p);
		expect(nudges).toHaveLength(2);
		const [capAsk, idleWarn] = nudges;
		if (capAsk === undefined || idleWarn === undefined || !("content" in idleWarn) || typeof idleWarn.content !== "string") {
			throw new Error("nudges without text content");
		}
		expect(capAsk).toEqual(consolidationNudgeMessage());
		expect(idleWarn.content).toContain("unchanged for 2 consecutive steps");
	});

	test("a step whose prompt carried no head neither nudges nor latches", () => {
		const p = procedure({ stateBytes: 100 }, { blob: "x".repeat(200) });

		expect(stepPrompt(p, [])).toBeUndefined();
		expect(p.capNudged).toBe(false);

		// From the next step, with the head back, the ask rides.
		recordReply(p, empty());
		expect(nudgesFor(p)).toEqual([consolidationNudgeMessage()]);
	});

	test("a cap of zero disables the nudge at any state size", () => {
		const p = projected({}, { blob: "x".repeat(1000) });

		expect(nudgesFor(p)).toEqual([]);
		expect(p.capNudged).toBe(false);
	});

	test("the cap measures both state messages: core and scratch rendered content summed", () => {
		// Each partition alone renders under the 250-byte cap; only the sum is over it.
		const p = projected({ stateBytes: 250 }, { goal: "x".repeat(100), blob: "y".repeat(100) });

		expect(nudgesFor(p)).toEqual([consolidationNudgeMessage()]);

		// Dropping the scratch key lands in a later step, the way a commit does.
		const drop = commitStep(p, { blob: null });
		if ("error" in drop) throw new Error(drop.error);
		recordReply(p, empty());
		expect(nudgesFor(p)).toEqual([]);
	});
});

describe("headMessages", () => {
	test("headMessages is the rules, P, state core and scratch state, in order", () => {
		const p = procedure({}, { goal: "x", plan: ["a"] });

		expect(headMessages(p)).toEqual([
			{ customType: RULES_MESSAGE_TYPE, content: OPERATING_RULES, display: false },
			{ customType: PROCEDURE_SPEC_MESSAGE_TYPE, content: "Running skill recon", display: false, details: { name: "recon" } },
			coreMessage({ goal: "x" }),
			scratchMessage({ plan: ["a"] }),
		]);
	});

	test("an empty core still renders as a stored empty-object message", () => {
		const p = procedure({}, { plan: ["a"] });

		expect(headMessages(p)[2]).toEqual(coreMessage({}));
		expect(headMessages(p)[3]).toEqual(scratchMessage({ plan: ["a"] }));
	});

	test("the head is byte-equal across calls for the same state", () => {
		const p = procedure({}, { goal: "x" });

		const head = headMessages(p);

		expect(headMessages(p)).toEqual(head);
	});

	test("a scratch-only patch leaves the core payload byte-equal and rewrites the scratch", () => {
		const p = procedure({}, { goal: "x" });
		const coreBefore = headMessages(p)[2];

		const reply = step({ plan: ["next"] });
		recordReply(p, reply);
		commit(p, reply);

		expect(headMessages(p)[2]).toEqual(coreBefore);
		expect(headMessages(p)[3]).toEqual(scratchMessage({ plan: ["next"] }));
	});

	test("a core-key patch changes the core payload", () => {
		const p = procedure({}, { goal: "x" });
		const coreBefore = headMessages(p)[2];

		const reply = step({ goal: "y" });
		recordReply(p, reply);
		commit(p, reply);

		expect(headMessages(p)[2]).not.toEqual(coreBefore);
		expect(headMessages(p)[2]).toEqual(coreMessage({ goal: "y" }));
	});
});

describe("compactionFor", () => {
	const preparation = { firstKeptEntryId: "h1", tokensBefore: 4321 };

	test("summarises to the full state, cuts at the current step and preserves both partitions", () => {
		const p = procedure({}, { goal: "g", plan: ["a"] });

		const result = compactionFor(p, preparation, [assistantEntry("a1"), assistantEntry("a2")]);

		expect(result).toEqual({
			compaction: {
				summary: `Execution state of procedure "recon" (skill-state runtime):\n\n${JSON.stringify({ goal: "g", plan: ["a"] }, null, 2)}`,
				shortSummary: 'skill-state: procedure "recon" execution state',
				firstKeptEntryId: "a2",
				tokensBefore: 4321,
				preserveData: { core: { goal: "g" }, scratch: { plan: ["a"] } },
			},
		});
	});

	test("a branch with no assistant message falls back to the harness's cut", () => {
		expect(compactionFor(procedure(), preparation, []).compaction?.firstKeptEntryId).toBe("h1");
	});

	test("a later compaction carries the live partitions", () => {
		const p = procedure({}, { goal: "g" });
		const reply = step({ step: 2 });
		recordReply(p, reply);
		commit(p, reply);

		expect(compactionFor(p, preparation, []).compaction?.preserveData).toEqual({ core: { goal: "g" }, scratch: { step: 2 } });
	});
});
