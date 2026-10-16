import { describe, expect, test } from "bun:test";
import { PROCEDURE_SPEC_MESSAGE_TYPE, RULES_MESSAGE_TYPE, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE, STATE_UPDATE_TOOL_NAME, coreMessage, rulesMessage, scratchMessage, specMessage } from "../src/messages";
import { commitStep, compactionFor, consolidationNudgeMessage, degradationNoticeMessage, fallbackNoticeMessage, headMessages, idleNudgeMessage, newProcedure, recordReply, stateMessages, stepPrompt, windowNoticeMessage } from "../src/procedure";
import type { Procedure } from "../src/procedure";
import { DEFAULT_PARAMS } from "../src/state";
import type { ExecutionState, StateParams, StateSchema } from "../src/state";
import type { AgentMessage } from "../src/types";
import { assistantEntry, ZERO_USAGE } from "./entries";

const schema: StateSchema = { type: "object", properties: { goal: { type: "string" } } };

// Every fixture tail is a handful of short messages, so a 100k-token window
// keeps each whole prompt far under the 30% prompt budget: nothing evicts,
// and the window notice only ever lists what the step actually carried.
const window = 100_000;

function procedure(params: Partial<StateParams> = {}, state: ExecutionState = {}): Procedure {
	return newProcedure("recon", "Running skill recon", schema, { ...DEFAULT_PARAMS, ...params }, state);
}

// The head as the context event would carry it: the harness stores each sent
// payload as a custom message, adding the role envelope the projection reads.
function headContext(procedure: Procedure): AgentMessage[] {
	return headMessages(procedure).map((payload) => ({ role: "custom" as const, timestamp: Date.now(), ...(payload as object) })) as unknown as AgentMessage[];
}

// The one user turn stored behind the head, as any engaged run has. Without
// it the step is degraded, a different branch of the seam.
function headWithTurn(procedure: Procedure): AgentMessage[] {
	return [...headContext(procedure), { role: "user", content: "go on", timestamp: Date.now() }];
}

// A procedure whose latest prompt carried the head: the model saw the rules,
// so a step without a state edit is idle. The flag is set the only way
// production sets it, through the stepPrompt seam.
function projected(params: Partial<StateParams> = {}, state: ExecutionState = {}): Procedure {
	const p = procedure(params, state);
	const msgs = headWithTurn(p);
	if (stepPrompt(p, msgs, msgs, window) === undefined) throw new Error("head did not project");
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

describe("consolidationNudgeMessage", () => {
	test("is a developer message asking for a state_update consolidation, with no fence, so it never becomes an elide target", () => {
		const nudge = consolidationNudgeMessage();
		expect(nudge).toEqual({
			role: "developer",
			content: expect.stringContaining("size cap"),
			timestamp: expect.any(Number),
		});
		if (!("content" in nudge) || typeof nudge.content !== "string") throw new Error("developer message without text content");
		expect(nudge.content).toContain(STATE_UPDATE_TOOL_NAME);
		expect(nudge.content.split("\n").some((line) => line.trimStart().startsWith("```"))).toBe(false);
	});
});

describe("idleNudgeMessage", () => {
	test("is a developer message naming the quiet run and asking for a state_update record, naming no cutoff and carrying no fence", () => {
		const ask = idleNudgeMessage(4);
		expect(ask).toEqual({
			role: "developer",
			content: expect.stringContaining("unchanged for 4 consecutive steps"),
			timestamp: expect.any(Number),
		});
		if (!("content" in ask) || typeof ask.content !== "string") throw new Error("developer message without text content");
		expect(ask.content).toContain(STATE_UPDATE_TOOL_NAME);
		expect(ask.content).not.toContain("disengage");
		expect(ask.content.split("\n").some((line) => line.trimStart().startsWith("```"))).toBe(false);
	});
});

describe("fallbackNoticeMessage", () => {
	test("is a developer message naming the incomplete head and the ordinary-context fallback", () => {
		const head = fallbackNoticeMessage();
		expect(head).toEqual({
			role: "developer",
			content: expect.stringContaining("the stored head is incomplete"),
			timestamp: expect.any(Number),
		});
		if (!("content" in head) || typeof head.content !== "string") throw new Error("developer message without text content");
		expect(head.content).toContain("projection");
	});
});

describe("degradationNoticeMessage", () => {
	test("is a developer message naming the missing transcript, the intact state and the continue ask", () => {
		const notice = degradationNoticeMessage();
		expect(notice).toEqual({
			role: "developer",
			content: expect.stringContaining("No recent transcript is in the prompt"),
			timestamp: expect.any(Number),
		});
		if (!("content" in notice) || typeof notice.content !== "string") throw new Error("developer message without text content");
		expect(notice.content).toContain("head only");
		expect(notice.content).toContain("intact and current");
		expect(notice.content).toContain("Continue from the state");
		// The projection gap never borrows the procedure's degrade wording.
		expect(notice.content).not.toContain("degrade");
	});
});

describe("windowNoticeMessage", () => {
	test("is one developer line listing the tail's tags oldest first with the eviction rule", () => {
		const notice = windowNoticeMessage([
			{ tag: "a3f2", toolName: "read" },
			{ tag: "b71c", toolName: "grep" },
		]);

		expect(notice.role).toBe("developer");
		if (!("content" in notice) || typeof notice.content !== "string") throw new Error("notice without text content");
		expect(notice.content).toBe("tail oldest→newest: #a3f2 read, #b71c grep — oldest evict first when the prompt outgrows its budget");
	});
});

describe("newProcedure", () => {
	test("starts with fresh counters and nothing pending", () => {
		expect(procedure()).toEqual({
			name: "recon",
			spec: "Running skill recon",
			schema,
			params: DEFAULT_PARAMS,
			state: {},
			stamp: 0,
			invalidPatches: 0,
			idle: 0,
			capNudged: false,
			idleNudged: false,
			fallbackNoticed: false,
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

		const reply = step({ "$append": { findings: ["a"] } }, { next_step: "b" });
		expect(recordReply(p, reply)).toEqual({ kind: "ok" });
		expect(p.pendingError).toBeUndefined();
		expect(p.invalidPatches).toBe(0);

		// The execute road lands where the fold landed.
		commit(p, reply);
		expect(p.state).toEqual({ findings: ["old", "a"], next_step: "b" });
	});

	test("a batch using $remove folds and commits to the same state", () => {
		const p = procedure({}, { findings: ["old", "gone"] });

		const reply = step({ "$remove": { findings: ["gone"] } }, { next_step: "b" });
		expect(recordReply(p, reply)).toEqual({ kind: "ok" });
		expect(p.pendingError).toBeUndefined();
		expect(p.invalidPatches).toBe(0);

		// The execute road lands where the fold landed.
		commit(p, reply);
		expect(p.state).toEqual({ findings: ["old"], next_step: "b" });
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

		const msgs = headWithTurn(p);
		if (stepPrompt(p, msgs, msgs, window) === undefined) throw new Error("head did not project");
		for (let i = 0; i < 7; i++) expect(recordReply(p, empty())).toEqual({ kind: "none" });
		expect(p.idle).toBe(7);
	});

	test("a quiet run never ends, however long it goes on", () => {
		const p = projected({ idleSteps: 2 });
		for (let i = 0; i < 6; i++) expect(recordReply(p, empty())).toEqual({ kind: "none" });
		expect(p.idle).toBe(6);
	});

	test("an unchanged patch is an idle step too", () => {
		const p = projected({ idleSteps: 2 }, { goal: "x" });
		expect(recordReply(p, step({ goal: "x" }))).toEqual({ kind: "none" });
		expect(recordReply(p, step({ goal: "x" }))).toEqual({ kind: "none" });
		expect(p.idle).toBe(2);
	});

	test("a patch that changes the state, or an invalid one, breaks an idle run", () => {
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
		// The first unprojected step carries the fallback notice; the repeat
		// keeps the ordinary context untouched.
		if (stepPrompt(p, [], [], window) === undefined) throw new Error("notice step returned nothing");
		if (stepPrompt(p, [], [], window) !== undefined) throw new Error("headless prompt projected");
		recordReply(p, empty());
		expect(p.idle).toBe(1);

		const msgs = headWithTurn(p);
		if (stepPrompt(p, msgs, msgs, window) === undefined) throw new Error("head did not project");
		for (let i = 0; i < 5; i++) expect(recordReply(p, empty())).toEqual({ kind: "none" });
		expect(p.idle).toBe(6);
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

	test("a commit builds the mirror with the messages: same partitions, same stamp, and the stamp bumps", () => {
		const p = projected();
		recordReply(p, empty());

		const committed = commitStep(p, { goal: "x" });

		if ("error" in committed) throw new Error(committed.error);
		expect(committed.mirror).toEqual({ core: { goal: "x" }, scratch: {}, stamp: 1 });
		expect(committed.sends).toEqual([coreMessage({ goal: "x" }, 1), scratchMessage({}, 1)]);
		expect(p.stamp).toBe(1);
	});

	test("each commit carries the next stamp, so two commits order by write stamp", () => {
		const p = projected();

		const first = commitStep(p, { goal: "x" });
		const second = commitStep(p, { goal: "y" });

		if ("error" in first || "error" in second) throw new Error("commit rejected");
		expect(first.mirror?.stamp).toBe(1);
		expect(second.mirror?.stamp).toBe(2);
	});

	test("head and final-state sends carry the current stamp and bump nothing", () => {
		const p = projected({}, { goal: "seed" });

		expect(stateMessages(p)).toEqual([coreMessage({ goal: "seed" }, 0), scratchMessage({}, 0)]);
		expect(p.stamp).toBe(0);

		const committed = commitStep(p, { goal: "y" });
		if ("error" in committed) throw new Error(committed.error);
		expect(headMessages(p).slice(2)).toEqual([coreMessage({ goal: "y" }, 1), scratchMessage({}, 1)]);
		expect(p.stamp).toBe(1);
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
	// The developer messages one step's prompt carries beyond its projection.
	function nudgesFor(procedure: Procedure): AgentMessage[] {
		const msgs = headWithTurn(procedure);
		const out = stepPrompt(procedure, msgs, msgs, window);
		if (out === undefined) throw new Error("head did not project");
		return out.filter((message) => message.role === "developer");
	}

	// The nudge rides with a build-time timestamp; match the text, not the clock.
	const consolidationNudge = () => ({ ...consolidationNudgeMessage(), timestamp: expect.any(Number) });
	const idleAsk = (idle: number) => ({ ...idleNudgeMessage(idle), timestamp: expect.any(Number) });

	test("returns nothing while the state is under the cap and leaves the latch off", () => {
		const p = projected();

		expect(nudgesFor(p)).toEqual([]);
		expect(p.capNudged).toBe(false);
	});

	test("hands the consolidation nudge out once per over-cap episode and is idempotent within the step", () => {
		const p = projected({ stateBytes: 100 }, { blob: "x".repeat(200) });

		// The ask rode on the first projected prompt and latched.
		expect(nudgesFor(p)).toEqual([consolidationNudge()]);
		expect(p.capNudged).toBe(true);
		// A repeated call in the same step re-serves the same set, never a duplicate.
		expect(nudgesFor(p)).toEqual([consolidationNudge()]);

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
		expect(nudgesFor(p)).toEqual([consolidationNudge()]);
	});

	test("no idle ask rides before the threshold", () => {
		const p = projected({ idleSteps: 3 });
		recordReply(p, empty());
		expect(nudgesFor(p)).toEqual([]);

		recordReply(p, empty());
		expect(nudgesFor(p)).toEqual([]);
	});

	test("the idle ask rides exactly at the threshold and names the count", () => {
		const p = projected({ idleSteps: 3 });
		recordReply(p, empty());
		recordReply(p, empty());
		recordReply(p, empty());

		const nudged = nudgesFor(p);
		expect(nudged).toEqual([idleAsk(3)]);
		const [ask] = nudged;
		if (ask === undefined || !("content" in ask) || typeof ask.content !== "string") throw new Error("ask without text content");
		expect(ask.role).toBe("developer");
		expect(ask.content).toContain("unchanged for 3 consecutive steps");
	});

	test("hands the idle ask out once per episode and is idempotent within the step", () => {
		const p = projected({ idleSteps: 2 });
		recordReply(p, empty());
		recordReply(p, empty());

		// The ask rode on the first prompt past the threshold and latched.
		expect(nudgesFor(p)).toEqual([idleAsk(2)]);
		expect(p.idleNudged).toBe(true);
		// A repeated call in the same step re-serves the same set, never a duplicate.
		expect(nudgesFor(p)).toEqual([idleAsk(2)]);

		// The next step re-evaluates: the latch holds, so nothing rides again.
		recordReply(p, empty());
		expect(nudgesFor(p)).toEqual([]);
	});

	test("a patch that changes the state, or an invalid one, breaks the idle run and re-arms the ask", () => {
		const valid = projected({ idleSteps: 2 });
		recordReply(valid, empty());
		recordReply(valid, empty());
		expect(nudgesFor(valid)).toEqual([idleAsk(2)]);

		// A valid changing patch commits and resets the idle run, re-arming the ask.
		recordReply(valid, step({ goal: "x" }));
		commit(valid, step({ goal: "x" }));
		recordReply(valid, empty());
		expect(nudgesFor(valid)).toEqual([]);
		recordReply(valid, empty());
		expect(nudgesFor(valid)).toEqual([idleAsk(2)]);

		// An invalid patch breaks the run too: it resets idle and re-arms.
		const invalid = projected({ idleSteps: 2 });
		recordReply(invalid, empty());
		recordReply(invalid, empty());
		expect(nudgesFor(invalid)).toEqual([idleAsk(2)]);
		expect(recordReply(invalid, step({ goal: 42 }))).toEqual({ kind: "block" });
		expect(invalid.idle).toBe(0);
		recordReply(invalid, empty());
		expect(nudgesFor(invalid)).toEqual([]);
		recordReply(invalid, empty());
		expect(nudgesFor(invalid)).toEqual([idleAsk(2)]);
	});

	test("a long quiet run never ends and asks exactly once", () => {
		const p = projected({ idleSteps: 5 });
		for (let i = 0; i < 12; i++) {
			expect(recordReply(p, empty())).toEqual({ kind: "none" });
			const asks = nudgesFor(p).filter((message) => "content" in message && typeof message.content === "string" && message.content.includes("unchanged for"));
			expect(asks).toHaveLength(i === 4 ? 1 : 0);
		}
	});

	test("a fresh cap ask and the idle ask ride on the same step, consolidation first", () => {
		const p = projected({ stateBytes: 200, idleSteps: 1 });
		expect(p.capNudged).toBe(false);

		// The commit puts the state over the cap; the next quiet step is also
		// the first past the idle threshold (idleSteps 1), so both asks ride
		// together.
		const grow = commitStep(p, { blob: "x".repeat(200) });
		if ("error" in grow) throw new Error(grow.error);
		recordReply(p, empty());

		const nudges = nudgesFor(p);
		expect(nudges).toHaveLength(2);
		expect(nudges).toEqual([consolidationNudge(), idleAsk(1)]);
	});

	test("a step whose prompt carried no head neither nudges nor latches", () => {
		const p = procedure({ stateBytes: 100 }, { blob: "x".repeat(200) });

		// The first unprojected step carries the fallback notice...
		const first = stepPrompt(p, [], [], window);
		if (first === undefined) throw new Error("first unprojected step returned nothing");
		expect(first.filter((message) => message.role === "developer")).toHaveLength(1);
		expect(p.capNudged).toBe(false);

		// ...and the second keeps the ordinary context untouched.
		expect(stepPrompt(p, [], [], window)).toBeUndefined();
		expect(p.capNudged).toBe(false);

		// From the next step, with the head back, the ask rides.
		recordReply(p, empty());
		expect(nudgesFor(p)).toEqual([consolidationNudge()]);
	});

	test("a cap of zero disables the nudge at any state size", () => {
		const p = projected({}, { blob: "x".repeat(1000) });

		expect(nudgesFor(p)).toEqual([]);
		expect(p.capNudged).toBe(false);
	});

	test("the cap measures both state messages: core and scratch rendered content summed", () => {
		// Each partition alone renders under the 250-byte cap; only the sum is over it.
		const p = projected({ stateBytes: 250 }, { goal: "x".repeat(100), blob: "y".repeat(100) });

		expect(nudgesFor(p)).toEqual([consolidationNudge()]);

		// Dropping the scratch key lands in a later step, the way a commit does.
		const drop = commitStep(p, { blob: null });
		if ("error" in drop) throw new Error(drop.error);
		recordReply(p, empty());
		expect(nudgesFor(p)).toEqual([]);
	});
});

describe("stepPrompt fallback notice", () => {
	// The developer messages an unprojected step's prompt carries: the fallback
	// notice, at most one per episode.
	function noticesIn(prompt: AgentMessage[] | undefined): AgentMessage[] {
		if (prompt === undefined) throw new Error("unprojected step returned nothing");
		return prompt.filter((message) => message.role === "developer");
	}

	function noticeText(notice: AgentMessage | undefined): string {
		if (notice === undefined || !("content" in notice) || typeof notice.content !== "string") throw new Error("notice without text content");
		return notice.content;
	}

	test("the first unprojected step carries exactly one developer notice naming the reason", () => {
		const p = procedure();

		const notices = noticesIn(stepPrompt(p, [], [], window));
		expect(notices).toHaveLength(1);
		expect(notices[0]!.role).toBe("developer");
		expect(noticeText(notices[0])).toContain("the stored head is incomplete");
		expect(p.projected).toBe(false);
	});

	test("an immediate repeat keeps the ordinary context untouched, never a second notice", () => {
		const p = procedure();

		expect(noticesIn(stepPrompt(p, [], [], window))).toHaveLength(1);
		expect(stepPrompt(p, [], [], window)).toBeUndefined();
	});

	test("a projected step ends the episode and re-arms the notice", () => {
		const p = procedure();

		expect(noticesIn(stepPrompt(p, [], [], window))).toHaveLength(1);
		const msgs = headWithTurn(p);
		if (stepPrompt(p, msgs, msgs, window) === undefined) throw new Error("head did not project");
		expect(p.projected).toBe(true);

		// Fallback again: a fresh notice, latched anew for the new episode.
		const notices = noticesIn(stepPrompt(p, [], [], window));
		expect(notices).toHaveLength(1);
		expect(noticeText(notices[0])).toContain("the stored head is incomplete");
	});

	test("fallback steps neither latch the cap ask nor move the idle count", () => {
		const p = procedure({ stateBytes: 100 }, { blob: "x".repeat(200) });

		expect(noticesIn(stepPrompt(p, [], [], window))).toHaveLength(1);
		expect(stepPrompt(p, [], [], window)).toBeUndefined();
		expect(p.capNudged).toBe(false);

		recordReply(p, empty());
		expect(p.idle).toBe(0);
	});
});

describe("stepPrompt window notice", () => {
	// The pair messages one step's reply leaves behind, as the harness stores them.
	function callMsg(id: string, name = "read"): AgentMessage {
		return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }], api: "anthropic-messages", provider: "anthropic", model: "m", usage: ZERO_USAGE, stopReason: "toolUse", timestamp: Date.now() };
	}
	function resultMsg(id: string, text: string, name = "read"): AgentMessage {
		return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
	}
	function devTexts(prompt: AgentMessage[]): string[] {
		return prompt
			.filter((message) => message.role === "developer")
			.map((message) => ("content" in message && typeof message.content === "string" ? message.content : ""));
	}

	test("a tool-result step carries the window notice before the nudges", () => {
		const p = procedure({ stateBytes: 100 }, { blob: "x".repeat(200) });
		const h = headContext(p);

		const msgs = [...h, callMsg("t1"), resultMsg("t1", "a")];
		const out = stepPrompt(p, msgs, msgs, window);
		if (out === undefined) throw new Error("head did not project");

		const texts = devTexts(out);
		expect(texts).toHaveLength(2);
		expect(texts[0]).toBe("tail oldest→newest: #ecd6 read — oldest evict first when the prompt outgrows its budget");
		expect(texts[1]).toContain("grown past its size cap");
	});

	test("the notice lists every tailed result oldest first, tags re-minted from the call ids", () => {
		const p = procedure();
		const h = headContext(p);

		const msgs = [...h, callMsg("t1"), resultMsg("t1", "a"), callMsg("t2"), resultMsg("t2", "b"), callMsg("t3"), resultMsg("t3", "c")];
		const out = stepPrompt(p, msgs, msgs, window);
		if (out === undefined) throw new Error("head did not project");

		expect(devTexts(out)).toEqual(["tail oldest→newest: #ecd6 read, #eb43 read, #e9b0 read — oldest evict first when the prompt outgrows its budget"]);
	});

	test("the notice rides before the idle ask at the threshold step", () => {
		const p = procedure({ idleSteps: 3 });
		const h = headContext(p);
		const msgs1 = [...h, callMsg("t1"), resultMsg("t1", "a")];
		stepPrompt(p, msgs1, msgs1, window);
		recordReply(p, empty());
		const msgs2 = [...h, callMsg("t2"), resultMsg("t2", "b")];
		stepPrompt(p, msgs2, msgs2, window);
		recordReply(p, empty());
		const msgs3 = [...h, callMsg("t3"), resultMsg("t3", "c")];
		stepPrompt(p, msgs3, msgs3, window);
		recordReply(p, empty());

		const msgs4 = [...h, callMsg("t4"), resultMsg("t4", "d")];
		const out = stepPrompt(p, msgs4, msgs4, window);
		if (out === undefined) throw new Error("head did not project");

		const texts = devTexts(out);
		expect(texts).toHaveLength(2);
		expect(texts[0]).toMatch(/^tail oldest→newest: /);
		expect(texts[1]).toContain("unchanged for 3 consecutive steps");
	});

	test("absent on a user-turn step", () => {
		const p = procedure();
		const h = headContext(p);

		const msgs: AgentMessage[] = [...h, { role: "user", content: "go on", timestamp: Date.now() }];
		const out = stepPrompt(p, msgs, msgs, window);
		if (out === undefined) throw new Error("head did not project");

		expect(devTexts(out)).toEqual([]);
	});

	test("absent on an unprojected step and when the head never reaches the seam", () => {
		const p = procedure();

		const msgs = [callMsg("t1"), resultMsg("t1", "a")];
		const first = stepPrompt(p, msgs, msgs, window);
		if (first === undefined) throw new Error("the first unprojected step returned nothing");
		const texts = devTexts(first);
		expect(texts).toHaveLength(1);
		expect(texts[0]).toContain("the stored head is incomplete");

		expect(stepPrompt(p, msgs, msgs, window)).toBeUndefined();
	});

	test("absent on a degraded step: the degradation notice is the only developer signal", () => {
		const p = procedure();
		const h = headContext(p);

		// Nothing is stored behind the head: the step is degraded.
		const out = stepPrompt(p, [...h], [...h], window);
		if (out === undefined) throw new Error("the degraded step returned nothing");

		const texts = devTexts(out);
		expect(texts).toHaveLength(1);
		expect(texts[0]).toContain("No recent transcript");
		expect(out.some((message) => message.role === "toolResult")).toBe(false);
	});
});

// A degraded step's context: the head with nothing stored behind it. Returns
// the prompt and its notice text.
function degradedStep(procedure: Procedure): { prompt: AgentMessage[]; notice: string } {
	const msgs = headContext(procedure);
	const out = stepPrompt(procedure, msgs, msgs, window);
	if (out === undefined) throw new Error("the degraded step returned nothing");
	const notice = out.find((message) => message.role === "developer");
	if (notice === undefined || !("content" in notice) || typeof notice.content !== "string") throw new Error("degraded step without its notice");
	return { prompt: out, notice: notice.content };
}

// The pair messages one step leaves behind, as the harness stores them: a
// healthy tail the next projection carries.
function healthyTail(callId: string, text = "ok"): AgentMessage[] {
	const call: AgentMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "read", arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	const result: AgentMessage = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
	return [call, result];
}

describe("stepPrompt degradation notice", () => {
	test("a degraded step's prompt is the head plus the notice, never ordinary history", () => {
		const p = projected();

		const { prompt } = degradedStep(p);

		// Four head messages, one developer notice, no window, no transcript.
		expect(prompt).toHaveLength(5);
		expect(prompt.slice(0, 4).map((message) => (message.role === "custom" ? message.customType : message.role))).toEqual([
			RULES_MESSAGE_TYPE,
			PROCEDURE_SPEC_MESSAGE_TYPE,
			STATE_CORE_MESSAGE_TYPE,
			STATE_SCRATCH_MESSAGE_TYPE,
		]);
		expect(prompt[4]!.role).toBe("developer");
		expect(prompt.some((message) => message.role === "toolResult" || message.role === "user")).toBe(false);
		expect(p.projected).toBe(false);
	});

	test("the notice rides every degraded step: no once-latch", () => {
		const p = projected();

		degradedStep(p);
		const second = degradedStep(p);

		expect(second.notice).toContain("No recent transcript");
	});

	test("the first projected step carries no degradation notice, and a later degraded step rides it again", () => {
		const p = projected();

		degradedStep(p);
		const msgs = [...headContext(p), ...healthyTail("t2")];
		const clean = stepPrompt(p, msgs, msgs, window);
		if (clean === undefined) throw new Error("the projected step returned nothing");
		const cleanDevs = clean.filter((message) => message.role === "developer");
		expect(cleanDevs).toHaveLength(1); // the window notice only
		expect(String("content" in cleanDevs[0]! ? cleanDevs[0]!.content : "")).toContain("tail oldest");
		expect(p.projected).toBe(true);

		const again = degradedStep(p);
		expect(again.notice).toContain("No recent transcript");
	});

	test("a degraded step is policy-neutral: no idle advance, no retry added, the reply judged as any reply", () => {
		const p = projected({ idleSteps: 3 });
		recordReply(p, empty());
		recordReply(p, empty());
		const idleBefore = p.idle;

		// The degraded step itself moves nothing.
		degradedStep(p);
		expect(p.idle).toBe(idleBefore);
		expect(p.invalidPatches).toBe(0);

		// An idle reply on a degraded step does not advance the idle count...
		recordReply(p, empty());
		expect(p.idle).toBe(idleBefore);

		// ...a patching reply is judged as any reply and resets the idle run...
		expect(recordReply(p, step({ goal: "x" }))).toEqual({ kind: "ok" });
		expect(p.idle).toBe(0);

		// ...and an invalid patch still consumes a retry: the reply's own
		// validity is never neutralised, only the degradation adds nothing.
		degradedStep(p);
		expect(recordReply(p, step({ goal: 42 }))).toEqual({ kind: "block" });
		expect(p.invalidPatches).toBe(1);
	});
});

describe("headMessages", () => {
	test("headMessages is the rules, P, state core and scratch state, in order", () => {
		const p = procedure({}, { goal: "x", plan: ["a"] });

		expect(headMessages(p)).toEqual([
			rulesMessage(),
			specMessage({ spec: "Running skill recon", name: "recon" }),
			coreMessage({ goal: "x" }, 0),
			scratchMessage({ plan: ["a"] }, 0),
		]);
	});

	test("an empty core still renders as a stored empty-object message", () => {
		const p = procedure({}, { plan: ["a"] });

		expect(headMessages(p)[2]).toEqual(coreMessage({}, 0));
		expect(headMessages(p)[3]).toEqual(scratchMessage({ plan: ["a"] }, 0));
	});

	test("the head is byte-equal across calls for the same state", () => {
		const p = procedure({}, { goal: "x" });

		const head = headMessages(p);

		expect(headMessages(p)).toEqual(head);
	});

	test("a scratch-only patch leaves the core content byte-equal and rewrites the scratch", () => {
		const p = procedure({}, { goal: "x" });
		const coreBefore = headMessages(p)[2];

		const reply = step({ plan: ["next"] });
		recordReply(p, reply);
		commit(p, reply);

		const coreAfter = headMessages(p)[2];
		if (typeof coreAfter !== "object" || typeof coreBefore !== "object" || !("content" in coreAfter) || !("content" in coreBefore)) throw new Error("state message lost its payload shape");
		// Same render, bumped stamp: the content the model and the cache see
		// is byte-identical, only details.stamp moved.
		expect(coreAfter.content).toBe(coreBefore.content);
		expect(coreMessage({ goal: "x" }, 1)).toEqual(coreAfter);
		expect(headMessages(p)[3]).toEqual(scratchMessage({ plan: ["next"] }, 1));
	});

	test("a core-key patch changes the core payload", () => {
		const p = procedure({}, { goal: "x" });
		const coreBefore = headMessages(p)[2];

		const reply = step({ goal: "y" });
		recordReply(p, reply);
		commit(p, reply);

		expect(headMessages(p)[2]).not.toEqual(coreBefore);
		expect(headMessages(p)[2]).toEqual(coreMessage({ goal: "y" }, 1));
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
