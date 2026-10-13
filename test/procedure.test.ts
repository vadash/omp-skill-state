import { describe, expect, test } from "bun:test";
import { PROCEDURE_SPEC_MESSAGE_TYPE, RULES_MESSAGE_TYPE, consolidationNudgeMessage, coreMessage, rulesMessage, scratchMessage } from "../src/messages";
import { commitStep, compactionFor, headMessages, newProcedure, recordReply, stateMessages, stepPrompt } from "../src/procedure";
import type { Procedure } from "../src/procedure";
import { DEFAULT_PARAMS } from "../src/state";
import type { ExecutionState, StateParams, StateSchema } from "../src/state";
import type { AgentMessage } from "../src/types";
import { assistantEntry, ZERO_USAGE } from "./entries";

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

		const reply = step({ findings: { $append: ["a"] } }, { next_step: "b" });
		expect(recordReply(p, reply)).toEqual({ kind: "ok" });
		expect(p.pendingError).toBeUndefined();
		expect(p.invalidPatches).toBe(0);

		// The execute road lands where the fold landed.
		commit(p, reply);
		expect(p.state).toEqual({ findings: ["old", "a"], next_step: "b" });
	});

	test("a batch using $remove folds and commits to the same state", () => {
		const p = procedure({}, { findings: ["old", "gone"] });

		const reply = step({ findings: { $remove: ["gone"] } }, { next_step: "b" });
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
		// The first unprojected step carries the fallback notice; the repeat
		// keeps the ordinary context untouched.
		if (stepPrompt(p, []) === undefined) throw new Error("notice step returned nothing");
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

	// The nudge rides with a build-time timestamp; match the text, not the clock.
	const consolidationNudge = () => ({ ...consolidationNudgeMessage(), timestamp: expect.any(Number) });

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
		expect(capAsk).toEqual(consolidationNudge());
		expect(idleWarn.content).toContain("unchanged for 2 consecutive steps");
	});

	test("a step whose prompt carried no head neither nudges nor latches", () => {
		const p = procedure({ stateBytes: 100 }, { blob: "x".repeat(200) });

		// The first unprojected step carries the fallback notice...
		const first = stepPrompt(p, []);
		if (first === undefined) throw new Error("first unprojected step returned nothing");
		expect(first.filter((message) => message.role === "developer")).toHaveLength(1);
		expect(p.capNudged).toBe(false);

		// ...and the second keeps the ordinary context untouched.
		expect(stepPrompt(p, [])).toBeUndefined();
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

		const notices = noticesIn(stepPrompt(p, []));
		expect(notices).toHaveLength(1);
		expect(notices[0]!.role).toBe("developer");
		expect(noticeText(notices[0])).toContain("the stored head is incomplete");
		expect(p.projected).toBe(false);
	});

	test("an immediate repeat keeps the ordinary context untouched, never a second notice", () => {
		const p = procedure();

		expect(noticesIn(stepPrompt(p, []))).toHaveLength(1);
		expect(stepPrompt(p, [])).toBeUndefined();
	});

	test("a projected step ends the episode and re-arms the notice", () => {
		const p = procedure();

		expect(noticesIn(stepPrompt(p, []))).toHaveLength(1);
		if (stepPrompt(p, headContext(p)) === undefined) throw new Error("head did not project");
		expect(p.projected).toBe(true);

		// Fallback again: a fresh notice, latched anew for the new episode.
		const notices = noticesIn(stepPrompt(p, []));
		expect(notices).toHaveLength(1);
		expect(noticeText(notices[0])).toContain("the stored head is incomplete");
	});

	test("an unmatched tool pair falls back with the notice naming that reason", () => {
		const p = procedure();
		const call: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: ZERO_USAGE,
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const mismatched: AgentMessage = {
			role: "toolResult",
			toolCallId: "other",
			toolName: "read",
			content: [{ type: "text", text: "mismatch" }],
			isError: false,
			timestamp: Date.now(),
		};

		const notices = noticesIn(stepPrompt(p, [...headContext(p), call, mismatched]));
		expect(notices).toHaveLength(1);
		expect(noticeText(notices[0])).toContain("a tool result does not answer the tool call before it");
		expect(p.projected).toBe(false);
	});

	test("fallback steps neither latch the cap ask nor move the idle count", () => {
		const p = procedure({ stateBytes: 100 }, { blob: "x".repeat(200) });

		expect(noticesIn(stepPrompt(p, []))).toHaveLength(1);
		expect(stepPrompt(p, [])).toBeUndefined();
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

		const out = stepPrompt(p, [...h, callMsg("t1"), resultMsg("t1", "a")]);
		if (out === undefined) throw new Error("head did not project");

		const texts = devTexts(out);
		expect(texts).toHaveLength(2);
		expect(texts[0]).toBe("window oldest→newest: #ecd6 read — oldest drop first as new results arrive");
		expect(texts[1]).toContain("grown past its size cap");
	});

	test("the notice lists the whole projected window oldest first, tags re-minted from the call ids", () => {
		const p = procedure();
		const h = headContext(p);

		const out = stepPrompt(p, [...h, callMsg("t1"), resultMsg("t1", "a"), callMsg("t2"), resultMsg("t2", "b"), callMsg("t3"), resultMsg("t3", "c")]);
		if (out === undefined) throw new Error("head did not project");

		expect(devTexts(out)).toEqual(["window oldest→newest: #ecd6 read, #eb43 read, #e9b0 read — oldest drop first as new results arrive"]);
	});

	test("the notice rides before the idle warning at the threshold step", () => {
		const p = procedure({ idleSteps: 3 });
		const h = headContext(p);
		stepPrompt(p, [...h, callMsg("t1"), resultMsg("t1", "a")]);
		recordReply(p, empty());
		stepPrompt(p, [...h, callMsg("t2"), resultMsg("t2", "b")]);
		recordReply(p, empty());

		const out = stepPrompt(p, [...h, callMsg("t3"), resultMsg("t3", "c")]);
		if (out === undefined) throw new Error("head did not project");

		const texts = devTexts(out);
		expect(texts).toHaveLength(2);
		expect(texts[0]).toMatch(/^window oldest→newest: /);
		expect(texts[1]).toContain("unchanged for 2 consecutive steps");
	});

	test("absent on a user-turn step", () => {
		const p = procedure();
		const h = headContext(p);

		const out = stepPrompt(p, [...h, { role: "user", content: "go on", timestamp: Date.now() }]);
		if (out === undefined) throw new Error("head did not project");

		expect(devTexts(out)).toEqual([]);
	});

	test("absent on an unprojected step and when the head never reaches the seam", () => {
		const p = procedure();

		const first = stepPrompt(p, [callMsg("t1"), resultMsg("t1", "a")]);
		if (first === undefined) throw new Error("the first unprojected step returned nothing");
		const texts = devTexts(first);
		expect(texts).toHaveLength(1);
		expect(texts[0]).toContain("the stored head is incomplete");

		expect(stepPrompt(p, [callMsg("t1"), resultMsg("t1", "a")])).toBeUndefined();
	});

	test("absent when the projection falls back on an unmatched pair", () => {
		const p = procedure();
		const h = headContext(p);

		const out = stepPrompt(p, [...h, callMsg("t1"), resultMsg("other", "mismatch")]);
		if (out === undefined) throw new Error("the fallback step returned nothing");

		const texts = devTexts(out);
		expect(texts).toHaveLength(1);
		expect(texts[0]).toContain("a tool result does not answer the tool call before it");
	});
});

describe("headMessages", () => {
	test("headMessages is the rules, P, state core and scratch state, in order", () => {
		const p = procedure({}, { goal: "x", plan: ["a"] });

		expect(headMessages(p)).toEqual([
			rulesMessage(DEFAULT_PARAMS),
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
