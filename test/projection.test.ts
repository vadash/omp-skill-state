import { describe, expect, test } from "bun:test";
import { OPERATING_RULES, RULES_MESSAGE_TYPE, PROCEDURE_SPEC_MESSAGE_TYPE, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE } from "../src/messages";
import { project } from "../src/projection";
import { isPlainObject } from "../src/types";
import type { AgentMessage } from "../src/types";
import { ZERO_USAGE } from "./entries";

// Live-state blocks the harness injects around the model; all of them must
// vanish from a projected prompt. The skill-state types appear too: an older
// superseded head message must lose to the latest one, and the legacy single
// state message must never leak into the projected tail.
const DROPPED_CUSTOM_TYPES = [
	"goal-mode-context",
	"plan-mode-context",
	"plan-mode-reference",
	"eager-todo-prelude",
	"eager-task-prelude",
	"mid-run-todo-nudge",
	"ttsr-injection",
	"todo-error-reminder",
	"experimental-context-notes-reminder",
	"skill-prompt",
	RULES_MESSAGE_TYPE,
	PROCEDURE_SPEC_MESSAGE_TYPE,
	STATE_CORE_MESSAGE_TYPE,
	STATE_SCRATCH_MESSAGE_TYPE,
	"sh.omp.skill-state.state",
];

let seq = 0;

function custom(customType: string, content = "noise", details?: Record<string, unknown>): AgentMessage {
	return { role: "custom", customType, content, display: false, ...(details === undefined ? {} : { details }), timestamp: seq++ };
}
const rulesMsg = () => custom(RULES_MESSAGE_TYPE, OPERATING_RULES);
const procedureSpecMsg = () => custom(PROCEDURE_SPEC_MESSAGE_TYPE, "Running skill recon\nBody of recon.");
const coreMsg = (state: Record<string, unknown> = {}) => custom(STATE_CORE_MESSAGE_TYPE, JSON.stringify(state, null, 2), { state });
const scratchMsg = (state: Record<string, unknown> = {}) => custom(STATE_SCRATCH_MESSAGE_TYPE, JSON.stringify(state, null, 2), { state });

function assistant(content: Extract<AgentMessage, { role: "assistant" }>["content"]): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: seq++,
	};
}
const assistantToolCall = (id: string, name = "read") => assistant([{ type: "toolCall", id, name, arguments: {} }]);

function assistantText(text: string): AgentMessage {
	return assistant([{ type: "text", text }]);
}

function toolResult(toolCallId: string, text: string, toolName = "read"): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: seq++,
	};
}

function userMsg(content: string): AgentMessage {
	return { role: "user", content, timestamp: seq++ };
}

function developerMsg(content: string): AgentMessage {
	return { role: "developer", content, timestamp: seq++ };
}

// Narrow a projected element to one role or fail the test; keeps member access typed.
function asToolResult(message: AgentMessage): Extract<AgentMessage, { role: "toolResult" }> {
	if (message.role !== "toolResult") throw new Error(`expected role toolResult, got ${message.role}`);
	return message;
}

function textBytes(messages: readonly AgentMessage[]): number {
	let total = 0;
	for (const message of messages) {
		const content: unknown = "content" in message ? message.content : undefined;
		if (typeof content === "string") {
			total += Buffer.byteLength(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string") {
				total += Buffer.byteLength(block.text);
			}
		}
	}
	return total;
}

// The stored head: rules, procedure spec, state core, scratch state. The
// projection returns the first three by reference and the scratch as a
// per-call copy, so the expected scratch in an assertion is `perCall(h.scratch)`.
function head() {
	const messages = [rulesMsg(), procedureSpecMsg(), coreMsg(), scratchMsg()];
	return { rules: messages[0]!, procedureSpec: messages[1]!, core: messages[2]!, scratch: messages[3]!, all: messages };
}

function perCall(stored: AgentMessage): AgentMessage {
	if (stored.role !== "custom") throw new Error("scratch head message is not a custom message");
	const details = isPlainObject(stored.details) ? stored.details : {};
	return { ...stored, details: { ...details, perCall: true } };
}

describe("project assembly", () => {
	test("tool-result step projects to rules, spec, core, scratch copy, pinned assistant, results in order", () => {
		const h = head();
		const call = assistant([
			{ type: "toolCall", id: "t1", name: "read", arguments: {} },
			{ type: "toolCall", id: "t2", name: "read", arguments: {} },
		]);
		const result1 = toolResult("t1", "first");
		const result2 = toolResult("t2", "second", "bash");
		const messages = [
			userMsg("old"),
			assistantText("old"),
			toolResult("t0", "old"),
			custom("goal-mode-context"),
			developerMsg("old instruction"),
			...h.all,
			custom("mid-run-todo-nudge"),
			call,
			result1,
			custom("ttsr-injection"),
			result2,
		];
		const out = project(messages, 32768)!;

		expect(out.map((m) => m.role)).toEqual(["custom", "custom", "custom", "custom", "assistant", "toolResult", "toolResult"]);
		expect(out.slice(0, 4).map((m) => (m.role === "custom" ? m.customType : m.role))).toEqual([
			RULES_MESSAGE_TYPE,
			PROCEDURE_SPEC_MESSAGE_TYPE,
			STATE_CORE_MESSAGE_TYPE,
			STATE_SCRATCH_MESSAGE_TYPE,
		]);
		expect(out[4]).toBe(call);
		expect(out[5]).toBe(result1);
		expect(out[6]).toBe(result2);
	});

	test("user step projects head plus trailing user batch, interleaved customs skipped", () => {
		const h = head();
		const first = userMsg("first");
		const second = userMsg("second");
		const out = project([...h.all, custom("todo-error-reminder"), first, developerMsg("nudge"), second], 32768)!;

		expect(out).toHaveLength(6);
		expect(out[4]).toBe(first);
		expect(out[5]).toBe(second);
	});

	test("a user turn projects the head, the preceding assistant prompt, and the user message", () => {
		const h = head();
		const promptAssistant = assistantText("Which candidate: (A) or (B)? I recommend (A).");
		const userReply = userMsg("Agree with recommendations.");

		const out = project([...h.all, promptAssistant, userReply], 32768)!;

		// Head (4) + Preceding Assistant (1) + User Reply (1) = 6
		expect(out).toHaveLength(6);
		expect(out[4]).toBe(promptAssistant);
		expect(out[5]).toBe(userReply);
	});

	test("multiple user messages still keep the single preceding assistant prompt", () => {
		const h = head();
		const promptAssistant = assistantText("Ready to proceed?");
		const user1 = userMsg("Yes.");
		const user2 = userMsg("Also remember to check tests.");

		const out = project([...h.all, promptAssistant, user1, user2], 32768)!;

		expect(out).toHaveLength(7);
		expect(out[4]).toBe(promptAssistant);
		expect(out[5]).toBe(user1);
		expect(out[6]).toBe(user2);
	});

	test("a user turn without a preceding assistant message projects head plus user turn only", () => {
		const h = head();
		const user = userMsg("First instruction");

		const out = project([...h.all, user], 32768)!;

		expect(out).toHaveLength(5);
		expect(out[4]).toBe(user);
	});

	test("a notice between the assistant prompt and the user reply does not break the pair", () => {
		const h = head();
		const promptAssistant = assistantText("Ready to proceed?");
		const reply = userMsg("Yes.");
		const out = project([...h.all, promptAssistant, custom("todo-error-reminder"), reply], 32768)!;

		expect(out).toHaveLength(6);
		expect(out[4]).toBe(promptAssistant);
		expect(out[5]).toBe(reply);
	});

	test("a tool result between the last turn and the reply means no antecedent", () => {
		const h = head();
		const call = assistantToolCall("t1");
		const result = toolResult("t1", "ok");
		const reply = userMsg("now widen the search");
		const out = project([...h.all, call, result, reply], 32768)!;

		expect(out).toHaveLength(5);
		expect(out[4]).toBe(reply);
	});

	test("returns the stored head and tail objects themselves when under the cap", () => {
		const h = head();
		const call = assistantToolCall("t1");
		const result = toolResult("t1", "ok");
		const out = project([...h.all, call, result], 32768)!;

		expect(out[0]).toBe(h.rules);
		expect(out[1]).toBe(h.procedureSpec);
		expect(out[2]).toBe(h.core);
		expect(out[4]).toBe(call);
		expect(out[5]).toBe(result);
	});

	test("the projected scratch is a per-call copy: unequal to the stored message, same model-visible bytes", () => {
		const h = head();
		const out = project([...h.all, assistantToolCall("t1"), toolResult("t1", "ok")], 32768)!;
		const copy = out[3]!;

		expect(copy).not.toEqual(h.scratch);
		if (copy.role !== "custom" || h.scratch.role !== "custom") throw new Error("scratch head message is not a custom message");
		expect(copy.role).toBe(h.scratch.role);
		expect(copy.customType).toBe(h.scratch.customType);
		expect(copy.content).toBe(h.scratch.content);
		// The one distinguishing field lives in details, outside role/content,
		// so the harness's deep-equality marking catches it and the provider
		// payload never sees it.
		const copyDetails = copy.details;
		expect(copyDetails !== null && typeof copyDetails === "object" && "perCall" in copyDetails && copyDetails.perCall).toBe(true);
		const storedDetails = h.scratch.details;
		expect(storedDetails !== null && typeof storedDetails === "object" && "perCall" in storedDetails).toBe(false);
	});

	test("the projected core is the stored reference: byte-equal across steps unless a core key changed", () => {
		const first = custom(STATE_CORE_MESSAGE_TYPE, '{"goal":"x"}', { state: { goal: "x" } });
		const second = custom(STATE_CORE_MESSAGE_TYPE, '{"goal":"x"}', { state: { goal: "x" } });
		const changed = custom(STATE_CORE_MESSAGE_TYPE, '{"goal":"y"}', { state: { goal: "y" } });
		const step = [assistantToolCall("t1"), toolResult("t1", "ok")];
		if (first.role !== "custom" || second.role !== "custom" || changed.role !== "custom") throw new Error("core fixture is not a custom message");

		// Returning the stored object itself is what keeps the bytes identical:
		// the projected core is the reference, never a re-rendering.
		const out = project([rulesMsg(), procedureSpecMsg(), first, scratchMsg(), ...step], 32768)!;
		expect(out[2]).toBe(first);

		const resaved = project([rulesMsg(), procedureSpecMsg(), first, second, scratchMsg(), ...step], 32768)!;
		expect(resaved[2]).toBe(second);
		expect(resaved[2]?.role === "custom" ? resaved[2].content : undefined).toBe(first.content);

		const moved = project([rulesMsg(), procedureSpecMsg(), first, changed, scratchMsg(), ...step], 32768)!;
		expect(moved[2]).toBe(changed);
		expect(moved[2]?.role === "custom" ? moved[2].content : undefined).not.toBe(first.content);
	});

	test("last wins per type: two stored scratch or core messages project the later one", () => {
		const h = head();
		const olderScratch = scratchMsg({ plan: ["old"] });
		const latestScratch = scratchMsg({ plan: ["new"] });
		const out = project([h.rules, olderScratch, h.procedureSpec, latestScratch, h.core, assistantToolCall("t1"), toolResult("t1", "ok")], 32768)!;

		expect(out[3]).toEqual(perCall(latestScratch));
		expect(out[3]).not.toEqual(perCall(olderScratch));

		const olderCore = coreMsg({ goal: "old" });
		const latestCore = coreMsg({ goal: "new" });
		const out2 = project([h.rules, olderCore, latestCore, h.procedureSpec, h.scratch, assistantToolCall("t1"), toolResult("t1", "ok")], 32768)!;

		expect(out2[2]).toBe(latestCore);
	});

	test("every live-state block, developer message and earlier turn is dropped", () => {
		for (const type of DROPPED_CUSTOM_TYPES) {
			const h = head();
			const call = assistantToolCall("t1");
			const result = toolResult("t1", "ok");
			const messages = [
				userMsg("old"),
				assistantText("old"),
				toolResult("t0", "old"),
				custom(type),
				...h.all,
				custom(type),
				call,
				custom(type),
				result,
			];
			// The latest custom of a head type wins, so an injected older head
			// message of the same type supersedes the fixture's copy. The
			// legacy single state message is never a head message: it only
			// ever vanishes.
			const lastInjected = messages[10]!;
			const expected = [
				type === RULES_MESSAGE_TYPE ? lastInjected : h.rules,
				type === PROCEDURE_SPEC_MESSAGE_TYPE ? lastInjected : h.procedureSpec,
				type === STATE_CORE_MESSAGE_TYPE ? lastInjected : h.core,
				type === STATE_SCRATCH_MESSAGE_TYPE ? perCall(lastInjected) : perCall(h.scratch),
				call,
				result,
			];
			expect(project(messages, 32768)).toEqual(expected);
		}
	});

	test("a developer message dropped between the pinned assistant and its results keeps pairing", () => {
		const h = head();
		const call = assistantToolCall("t1");
		const result = toolResult("t1", "ok");
		const out = project([...h.all, call, developerMsg("interleave"), result], 32768)!;

		expect(out).toHaveLength(6);
		expect(out[4]).toBe(call);
		expect(out[5]).toBe(result);
		expect(asToolResult(out[5]!).toolCallId).toBe("t1");
	});

	test("missing rules, procedure spec, core or scratch leaves the call unprojected", () => {
		const complete = [...head().all, assistantToolCall("t1"), toolResult("t1", "ok")];
		for (const drop of [0, 1, 2, 3]) {
			expect(project(complete.filter((_, i) => i !== drop), 32768)).toBeUndefined();
		}
	});

	test("a branch holding only the legacy single state message is inert, never a two-message head", () => {
		const h = head();
		const legacy = [...h.all.slice(0, 2), custom("sh.omp.skill-state.state", "{}", { state: { goal: "x" } })];
		expect(project([...legacy, assistantToolCall("t1"), toolResult("t1", "ok")], 32768)).toBeUndefined();
		expect(project([...h.all.slice(0, 2), h.core, legacy[2]!, assistantToolCall("t1"), toolResult("t1", "ok")], 32768)).toBeUndefined();
	});

	test("trailing tool results without a preceding assistant tool call leave the call unprojected", () => {
		const h = head();
		expect(project([...h.all, userMsg("hi"), toolResult("t1", "orphan")], 32768)).toBeUndefined();
		expect(project([...h.all, assistantText("no calls"), toolResult("t1", "orphan")], 32768)).toBeUndefined();
	});

	test("a result that answers no toolCall in the pinned assistant leaves the call unprojected", () => {
		const h = head();
		expect(project([...h.all, assistantToolCall("t1"), toolResult("t1", "ok"), toolResult("t2", "stray")], 32768)).toBeUndefined();
		expect(project([...h.all, assistantToolCall("t1"), toolResult("other", "mismatch")], 32768)).toBeUndefined();
	});

	test("a trailing text-only assistant projects to the head only", () => {
		const h = head();
		const out = project([...h.all, assistantText("thinking out loud")], 32768)!;

		expect(out).toEqual([h.rules, h.procedureSpec, h.core, perCall(h.scratch)]);
	});

	test("a fresh procedure with only the skill prompt and the head projects to the head only", () => {
		const h = head();
		const out = project([custom("skill-prompt"), ...h.all, developerMsg("note")], 32768)!;

		expect(out).toEqual([h.rules, h.procedureSpec, h.core, perCall(h.scratch)]);
	});

	test("a trailing assistant tool call with no result yet projects to the head only", () => {
		const h = head();
		const out = project([...h.all, assistantToolCall("t1")], 32768)!;

		expect(out).toEqual([h.rules, h.procedureSpec, h.core, perCall(h.scratch)]);
	});

	test("project never mutates its input, including under truncation", () => {
		const truncated = [...head().all, assistantToolCall("t1"), toolResult("t1", "y".repeat(500))];
		const snapshot = structuredClone(truncated);
		project(truncated, 200);
		expect(truncated).toEqual(snapshot);

		const untouched = [...head().all, userMsg("keep")];
		const snapshot2 = structuredClone(untouched);
		project(untouched, 10);
		expect(untouched).toEqual(snapshot2);
	});
});

describe("project observation cap", () => {
	test("over the cap the largest result is cut from the end and carries the marker", () => {
		const h = head();
		const result = toolResult("call-9", "a".repeat(400), "bash");
		const out = project([...h.all, assistantToolCall("call-9", "bash"), result], 300)!;
		const capped = asToolResult(out[5]!);
		const marker = capped.content.at(-1)!;

		expect(out[5]).not.toBe(result);
		expect(capped.toolCallId).toBe("call-9");
		expect(marker.type).toBe("text");
		const markerText = marker.type === "text" ? marker.text : "";
		expect(markerText).toMatch(
			/^\[skill-state: observation cap 300 bytes exceeded; cut \d+ bytes from the end of this bash result \(call-9\); re-run the tool on a narrower range to read the rest\]$/,
		);
		const cut = Number(markerText.match(/cut (\d+) bytes/)![1]);
		const kept = capped.content[0]!;
		expect(kept.type).toBe("text");
		expect(cut).toBe(400 - Buffer.byteLength(kept.type === "text" ? kept.text : ""));
		expect(textBytes(out.filter((m) => m.role === "toolResult"))).toBeLessThanOrEqual(300);
	});

	test("under the cap results pass through untouched", () => {
		const h = head();
		const result = toolResult("t1", "small");
		const out = project([...h.all, assistantToolCall("t1"), result], 32768)!;

		expect(out[5]).toBe(result);
	});

	test("multi-byte UTF-8 is cut on code point boundaries without replacement chars", () => {
		const h = head();
		const result = toolResult("t1", "€".repeat(200));
		const out = project([...h.all, assistantToolCall("t1"), result], 300)!;
		const capped = asToolResult(out[5]!);
		const text = capped.content
			.map((b) => (b.type === "text" ? b.text : ""))
			.join("");

		expect(text).not.toContain("�");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(300);
	});

	test("two oversized results are both cut as needed", () => {
		const h = head();
		const r1 = toolResult("t1", "1".repeat(300));
		const r2 = toolResult("t2", "2".repeat(300), "bash");
		const out = project([...h.all, assistant([
			{ type: "toolCall", id: "t1", name: "read", arguments: {} },
			{ type: "toolCall", id: "t2", name: "read", arguments: {} },
		]), r1, r2], 350)!;
		const capped1 = asToolResult(out[5]!);
		const capped2 = asToolResult(out[6]!);
		const marker1 = capped1.content.at(-1)!;
		const marker2 = capped2.content.at(-1)!;

		expect(out[5]).not.toBe(r1);
		expect(out[6]).not.toBe(r2);
		expect(marker1.type === "text" && marker1.text).toContain("this read result (t1)");
		expect(marker2.type === "text" && marker2.text).toContain("this bash result (t2)");
		expect(textBytes(out.filter((m) => m.role === "toolResult"))).toBeLessThanOrEqual(350);
	});

	test("below one marker per result, every result is cut to its whole marker (the cap's floor)", () => {
		const h = head();
		const r1 = toolResult("t1", "1".repeat(300));
		const r2 = toolResult("t2", "2".repeat(300), "bash");
		const out = project([...h.all, assistant([
			{ type: "toolCall", id: "t1", name: "read", arguments: {} },
			{ type: "toolCall", id: "t2", name: "read", arguments: {} },
		]), r1, r2], 100)!;
		const capped = [asToolResult(out[5]!), asToolResult(out[6]!)];

		for (const [i, result] of capped.entries()) {
			expect(result.content).toHaveLength(1);
			const marker = result.content[0]!;
			expect(marker.type === "text" && marker.text).toContain(`cut 300 bytes from the end of this ${i === 0 ? "read" : "bash"} result`);
		}
		expect(textBytes(capped)).toBeGreaterThan(100);
	});

	test("the user turn is never truncated", () => {
		const h = head();
		const turn = userMsg("u".repeat(5000));
		const out = project([...h.all, turn], 100)!;

		expect(out[4]).toBe(turn);
	});

	test("a total exactly at the cap passes through untouched", () => {
		const h = head();
		const result = toolResult("t1", "x".repeat(300));
		const out = project([...h.all, assistantToolCall("t1"), result], 300)!;

		expect(out[5]).toBe(result);
	});

	test("non-text blocks are neither counted nor cut", () => {
		const h = head();
		const image: AgentMessage = {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [{ type: "image", data: "A".repeat(1000), mimeType: "image/png" }],
			isError: false,
			timestamp: seq++,
		};
		const text = toolResult("t2", "y".repeat(400), "bash");
		const out = project([...h.all, assistant([
			{ type: "toolCall", id: "t1", name: "read", arguments: {} },
			{ type: "toolCall", id: "t2", name: "bash", arguments: {} },
		]), image, text], 300)!;

		expect(out[5]).toBe(image);
		expect(out[6]).not.toBe(text);
		expect(textBytes([out[6]!])).toBeLessThanOrEqual(300);
	});
});

describe("project observation window", () => {
	test("window 3 pins the three most recent pairs in chronological order and drops older pairs", () => {
		const h = head();
		const droppedCall = assistantToolCall("t0");
		const droppedResult = toolResult("t0", "old");
		const call1 = assistantToolCall("t1");
		const result1 = toolResult("t1", "first");
		const call2 = assistantToolCall("t2", "bash");
		const result2 = toolResult("t2", "second", "bash");
		const call3 = assistantToolCall("t3");
		const result3 = toolResult("t3", "third");
		const out = project(
			[...h.all, droppedCall, droppedResult, call1, result1, call2, result2, call3, result3],
			32768,
			3,
		)!;

		expect(out).toHaveLength(10);
		expect(out[4]).toBe(call1);
		expect(out[5]).toBe(result1);
		expect(out[6]).toBe(call2);
		expect(out[7]).toBe(result2);
		expect(out[8]).toBe(call3);
		expect(out[9]).toBe(result3);
	});

	test("a mismatched older pair stops the walk and keeps the newer pairs", () => {
		const h = head();
		const call1 = assistantToolCall("t1");
		const result1 = toolResult("t1", "first");
		const call2 = assistantToolCall("t2");
		const result2 = toolResult("t2", "second");
		const out = project(
			[...h.all, assistantToolCall("t0"), toolResult("tZ", "mismatch"), call1, result1, call2, result2],
			32768,
			3,
		)!;

		expect(out).toHaveLength(8);
		expect(out[4]).toBe(call1);
		expect(out[5]).toBe(result1);
		expect(out[6]).toBe(call2);
		expect(out[7]).toBe(result2);
	});

	test("an older pair whose nearest message is not an assistant stops the walk", () => {
		const h = head();
		const call1 = assistantToolCall("t1");
		const result1 = toolResult("t1", "first");
		const call2 = assistantToolCall("t2");
		const result2 = toolResult("t2", "second");
		const out = project([...h.all, userMsg("plain turn"), call1, result1, call2, result2], 32768, 3)!;

		expect(out).toHaveLength(8);
		expect(out[4]).toBe(call1);
		expect(out[7]).toBe(result2);
	});

	test("an older assistant with no results of its own stops the walk", () => {
		const h = head();
		const call2 = assistantToolCall("t2");
		const result2 = toolResult("t2", "second");
		const out = project([...h.all, assistantToolCall("t1"), call2, result2], 32768, 3)!;

		expect(out).toHaveLength(6);
		expect(out[4]).toBe(call2);
		expect(out[5]).toBe(result2);
	});

	test("a window wider than the available pairs projects the pairs that exist", () => {
		const h = head();
		const call1 = assistantToolCall("t1");
		const result1 = toolResult("t1", "first");
		const call2 = assistantToolCall("t2");
		const result2 = toolResult("t2", "second");
		const out = project([...h.all, call1, result1, call2, result2], 32768, 5)!;

		expect(out).toHaveLength(8);
		expect(out[4]).toBe(call1);
		expect(out[7]).toBe(result2);
	});

	test("the cap covers the whole window: both pairs are cut, largest first", () => {
		const h = head();
		const r1 = toolResult("t1", "1".repeat(300));
		const r2 = toolResult("t2", "2".repeat(300), "bash");
		const out = project(
			[...h.all, assistantToolCall("t1"), r1, assistantToolCall("t2", "bash"), r2],
			350,
			2,
		)!;
		const capped1 = asToolResult(out[5]!);
		const capped2 = asToolResult(out[7]!);

		expect(out[5]).not.toBe(r1);
		expect(out[7]).not.toBe(r2);
		expect(capped1.content.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("this read result (t1)") });
		expect(capped2.content.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("this bash result (t2)") });
		expect(textBytes(out.filter((m) => m.role === "toolResult"))).toBeLessThanOrEqual(350);
	});

	test("below one marker per result across the window, every result is cut to its whole marker", () => {
		const h = head();
		const r1 = toolResult("t1", "1".repeat(300));
		const r2 = toolResult("t2", "2".repeat(300), "bash");
		const out = project(
			[...h.all, assistantToolCall("t1"), r1, assistantToolCall("t2", "bash"), r2],
			100,
			2,
		)!;
		const capped = [asToolResult(out[5]!), asToolResult(out[7]!)];

		for (const [i, result] of capped.entries()) {
			expect(result.content).toHaveLength(1);
			const marker = result.content[0]!;
			expect(marker.type === "text" && marker.text).toContain(`cut 300 bytes from the end of this ${i === 0 ? "read" : "bash"} result`);
		}
		expect(textBytes(capped)).toBeGreaterThan(100);
	});

	test("project never mutates its input with a wider window, including under truncation", () => {
		const messages = [
			...head().all,
			assistantToolCall("t1"),
			toolResult("t1", "y".repeat(500)),
			assistantToolCall("t2"),
			toolResult("t2", "z".repeat(500)),
			assistantToolCall("t3"),
			toolResult("t3", "w".repeat(500)),
		];
		const snapshot = structuredClone(messages);
		project(messages, 200, 3);
		expect(messages).toEqual(snapshot);
	});
});

describe("project flat band", () => {
	test("projected length and size at step 30 match step 5 within a fixed constant", () => {
		const messages: AgentMessage[] = [...head().all];
		let seed = 42;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		let early: AgentMessage[] | undefined;
		let late: AgentMessage[] | undefined;
		for (let step = 1; step <= 30; step++) {
			messages.push(custom(DROPPED_CUSTOM_TYPES[Math.floor(rand() * 10)]!));
			if (rand() < 0.5) messages.push(userMsg(`note ${step}`));
			messages.push(assistantToolCall(`t${step}`));
			messages.push(toolResult(`t${step}`, "x".repeat(2048)));
			if (step % 3 === 0) messages.push(scratchMsg({ step }));
			if (step === 5) early = project(messages, 8192);
			if (step === 30) late = project(messages, 8192);
		}

		// Four head messages plus the pinned pair, at every step.
		expect(early).toHaveLength(6);
		expect(late).toHaveLength(6);
		expect(textBytes(late!)).toBeLessThanOrEqual(textBytes(early!) + 64);
	});
});
