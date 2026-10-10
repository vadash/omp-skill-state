import { describe, expect, test } from "bun:test";
import { OPERATING_RULES, RULES_MESSAGE_TYPE, PROCEDURE_SPEC_MESSAGE_TYPE, STATE_MESSAGE_TYPE } from "./patch";
import { project } from "./projection";
import type { AgentMessage } from "./projection";

// Live-state blocks the harness injects around the model; all of them must
// vanish from a projected prompt. The three skill-state types appear too: an
// older superseded head message must lose to the latest one.
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
	STATE_MESSAGE_TYPE,
];

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let seq = 0;

function custom(customType: string, content = "noise"): AgentMessage {
	return { role: "custom", customType, content, display: false, timestamp: seq++ };
}
const rulesMsg = () => custom(RULES_MESSAGE_TYPE, OPERATING_RULES);
const procedureSpecMsg = () => custom(PROCEDURE_SPEC_MESSAGE_TYPE, "Running skill recon\nBody of recon.");
const stateMsg = (state: Record<string, unknown> = {}) =>
	custom(STATE_MESSAGE_TYPE, `\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``);

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

function head() {
	const messages = [rulesMsg(), procedureSpecMsg(), stateMsg()];
	return { rules: messages[0]!, procedureSpec: messages[1]!, state: messages[2]!, all: messages };
}

describe("project assembly", () => {
	test("tool-result step projects to rules, procedure spec, state, pinned assistant, results in order", () => {
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

		expect(out.map((m) => m.role)).toEqual(["custom", "custom", "custom", "assistant", "toolResult", "toolResult"]);
		expect(out.slice(0, 3).map((m) => (m.role === "custom" ? m.customType : m.role))).toEqual([
			RULES_MESSAGE_TYPE,
			PROCEDURE_SPEC_MESSAGE_TYPE,
			STATE_MESSAGE_TYPE,
		]);
		expect(out[3]).toBe(call);
		expect(out[4]).toBe(result1);
		expect(out[5]).toBe(result2);
	});

	test("user step projects head plus trailing user batch, interleaved customs skipped", () => {
		const h = head();
		const first = userMsg("first");
		const second = userMsg("second");
		const out = project([...h.all, custom("todo-error-reminder"), first, developerMsg("nudge"), second], 32768)!;

		expect(out).toHaveLength(5);
		expect(out[3]).toBe(first);
		expect(out[4]).toBe(second);
	});

	test("returns the stored head and tail objects themselves when under the cap", () => {
		const h = head();
		const call = assistantToolCall("t1");
		const result = toolResult("t1", "ok");
		const out = project([...h.all, call, result], 32768)!;

		expect(out[0]).toBe(h.rules);
		expect(out[1]).toBe(h.procedureSpec);
		expect(out[2]).toBe(h.state);
		expect(out[3]).toBe(call);
		expect(out[4]).toBe(result);
	});

	test("the latest state message wins and older ones are absent", () => {
		const h = head();
		const older = stateMsg({ step: 1 });
		const latest = stateMsg({ step: 2 });
		const out = project([h.rules, older, h.procedureSpec, latest, assistantToolCall("t1"), toolResult("t1", "ok")], 32768)!;

		expect(out).toHaveLength(5);
		expect(out[2]).toBe(latest);
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
			// message of the same type supersedes the fixture's copy.
			const expected = [
				type === RULES_MESSAGE_TYPE ? messages[9] : h.rules,
				type === PROCEDURE_SPEC_MESSAGE_TYPE ? messages[9] : h.procedureSpec,
				type === STATE_MESSAGE_TYPE ? messages[9] : h.state,
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

		expect(out).toHaveLength(5);
		expect(out[3]).toBe(call);
		expect(out[4]).toBe(result);
		expect(asToolResult(out[4]!).toolCallId).toBe("t1");
	});

	test("missing rules, procedure spec or state leaves the call unprojected", () => {
		const complete = [...head().all, assistantToolCall("t1"), toolResult("t1", "ok")];
		for (const drop of [0, 1, 2]) {
			expect(project(complete.filter((_, i) => i !== drop), 32768)).toBeUndefined();
		}
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

		expect(out).toEqual([h.rules, h.procedureSpec, h.state]);
	});

	test("a fresh procedure with only the skill prompt and the head projects to the head only", () => {
		const h = head();
		const out = project([custom("skill-prompt"), ...h.all, developerMsg("note")], 32768)!;

		expect(out).toEqual([h.rules, h.procedureSpec, h.state]);
	});

	test("a trailing assistant tool call with no result yet projects to the head only", () => {
		const h = head();
		const out = project([...h.all, assistantToolCall("t1")], 32768)!;

		expect(out).toEqual([h.rules, h.procedureSpec, h.state]);
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
		const capped = asToolResult(out[4]!);
		const marker = capped.content.at(-1)!;

		expect(out[4]).not.toBe(result);
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

		expect(out[4]).toBe(result);
	});

	test("multi-byte UTF-8 is cut on code point boundaries without replacement chars", () => {
		const h = head();
		const result = toolResult("t1", "€".repeat(200));
		const out = project([...h.all, assistantToolCall("t1"), result], 300)!;
		const capped = asToolResult(out[4]!);
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
		const capped1 = asToolResult(out[4]!);
		const capped2 = asToolResult(out[5]!);
		const marker1 = capped1.content.at(-1)!;
		const marker2 = capped2.content.at(-1)!;

		expect(out[4]).not.toBe(r1);
		expect(out[5]).not.toBe(r2);
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
		const capped = [asToolResult(out[4]!), asToolResult(out[5]!)];

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

		expect(out[3]).toBe(turn);
	});

	test("a total exactly at the cap passes through untouched", () => {
		const h = head();
		const result = toolResult("t1", "x".repeat(300));
		const out = project([...h.all, assistantToolCall("t1"), result], 300)!;

		expect(out[4]).toBe(result);
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

		expect(out[4]).toBe(image);
		expect(out[5]).not.toBe(text);
		expect(textBytes([out[5]!])).toBeLessThanOrEqual(300);
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
			if (step % 3 === 0) messages.push(stateMsg({ step }));
			if (step === 5) early = project(messages, 8192);
			if (step === 30) late = project(messages, 8192);
		}

		// Three head messages plus the pinned pair, at every step.
		expect(early).toHaveLength(5);
		expect(late).toHaveLength(5);
		expect(textBytes(late!)).toBeLessThanOrEqual(textBytes(early!) + 64);
	});
});
