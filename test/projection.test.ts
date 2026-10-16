import { describe, expect, test } from "bun:test";
import { LEGACY_STATE_MESSAGE_TYPE, LIVE_STATE_CUSTOM_TYPES, OPERATING_RULES, RULES_MESSAGE_TYPE, PROCEDURE_SPEC_MESSAGE_TYPE, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE } from "../src/messages";
import { project } from "../src/projection";
import { DEFAULT_PARAMS } from "../src/state";
import { isPlainObject } from "../src/types";
import type { AgentMessage } from "../src/types";
import { ZERO_USAGE } from "./entries";

let seq = 0;

function custom(customType: string, content = "noise", details?: Record<string, unknown>): AgentMessage {
	return { role: "custom", customType, content, display: false, ...(details === undefined ? {} : { details }), timestamp: seq++ } as AgentMessage;
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

function toolResult(toolCallId: string, text: string, toolName = "read"): Extract<AgentMessage, { role: "toolResult" }> {
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

// The success branch of project: the result object's prompt.
function projected(
	messages: AgentMessage[],
	observationBytes = 32768,
	opts: { windowTokens?: number; branch?: readonly AgentMessage[] } = {},
): AgentMessage[] {
	const out = project(messages, opts.branch ?? messages, { ...DEFAULT_PARAMS, observationBytes }, opts.windowTokens);
	if (typeof out === "string") throw new Error(`unexpected fallback: ${out}`);
	if ("head" in out) throw new Error("unexpected degraded projection");
	return out.prompt;
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

// Whole-message byte size, the proxy the tail budget itself measures.
function byteSize(message: AgentMessage): number {
	return Buffer.byteLength(JSON.stringify(message));
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

// The prompt order: rules, spec, core, tail, scratch copy. The tail length
// varies, so the scratch copy is located from the end.
describe("project tail assembly", () => {
	test("a parked older-stamped state message after a newer one does not time-travel the prompt", () => {
		// The core/scratch halves pick by write stamp, position as the final
		// tiebreak (ADR 0012): a parked next-turn send of the older commit
		// landing after the newer pair must not overwrite the prompt's state.
		const newerCore = custom(STATE_CORE_MESSAGE_TYPE, JSON.stringify({ goal: "new" }), { state: { goal: "new" }, stamp: 2 });
		const newerScratch = custom(STATE_SCRATCH_MESSAGE_TYPE, "{}", { state: {}, stamp: 2 });
		const parkedCore = custom(STATE_CORE_MESSAGE_TYPE, JSON.stringify({ goal: "old" }), { state: { goal: "old" }, stamp: 1 });
		const parkedScratch = custom(STATE_SCRATCH_MESSAGE_TYPE, "{}", { state: {}, stamp: 1 });
		const messages = [rulesMsg(), procedureSpecMsg(), newerCore, newerScratch, parkedCore, parkedScratch, userMsg("go on")];

		const out = projected(messages);

		expect(out[2]).toBe(newerCore);
		expect(out.at(-1)).toEqual(perCall(newerScratch));
	});

	test("unstamped state messages keep positional-last: the messages predate stamps", () => {
		const messages = [rulesMsg(), procedureSpecMsg(), coreMsg({ goal: "only" }), scratchMsg({}), coreMsg({ goal: "later" }), scratchMsg({}), userMsg("go on")];

		const out = projected(messages);

		expect(out[2]).toBe(messages[4]);
		expect(out.at(-1)).toEqual(perCall(messages[5]));
	});
	test("a step's prompt carries the run's recent conversation behind the state core, byte-identical to stored", () => {
		const h = head();
		const turn = userMsg("the task, restated mid-run");
		const prose = assistantText("Reading the config first.");
		const call = assistantToolCall("t0");
		const result = toolResult("t0", "file contents");
		const newestCall = assistantToolCall("t1");
		const newestResult = toolResult("t1", "newer contents");
		// The head lands first at engage; the run's conversation is stored
		// behind it and is the tail.
		const branch = [...h.all, turn, prose, call, result, newestCall, newestResult];

		const out = projected([...h.all, turn, prose, call, result, newestCall, newestResult]);

		expect(out[0]).toBe(h.rules);
		expect(out[1]).toBe(h.procedureSpec);
		expect(out[2]).toBe(h.core);
		// The tail: every stored message after the newest head custom, oldest first.
		expect(out[3]).toBe(turn);
		expect(out[4]).toBe(prose);
		expect(out[5]).toBe(call);
		expect(out[7]).toBe(newestCall);
		// Tool results are the one tail exception: the stored content rides
		// unchanged behind the added tag line.
		expect(asToolResult(out[6]!).content.slice(1)).toEqual(result.content);
		expect(asToolResult(out[8]!).content.slice(1)).toEqual(newestResult.content);
		// The scratch copy closes the prompt.
		expect(out).toHaveLength(10);
		expect(out.at(-1)).toEqual(perCall(h.scratch));
	});

	test("the tail rides between the state core and the scratch copy", () => {
		const h = head();
		const out = projected([...h.all, userMsg("turn"), assistantText("prose")]);

		expect(out.map((m) => m.role)).toEqual(["custom", "custom", "custom", "user", "assistant", "custom"]);
		expect(out[2]!.role === "custom" && out[2].customType).toBe(STATE_CORE_MESSAGE_TYPE);
		expect(out.at(-1)).toEqual(perCall(h.scratch));
	});

	test("the tail begins after the newest spine custom: a later rules or spec copy cuts everything before it", () => {
		const h = head();
		const mid = userMsg("mid-run turn");
		const lateSpec = custom(PROCEDURE_SPEC_MESSAGE_TYPE, "re-sent spec");
		const latest = userMsg("latest turn");
		const out = projected([...h.all, mid, lateSpec, latest]);

		// The re-sent spec is the newest spine custom, so the mid-run turn
		// sits before the tail's start and the latest turn is the whole tail.
		// The later scratch only wins the head lookup; it is excluded from the
		// tail by type.
		expect(out).toHaveLength(5);
		expect(out[0]).toBe(h.rules);
		expect(out[1]).toBe(lateSpec);
		expect(out[3]).toBe(latest);
		expect(out.some((m) => m === mid)).toBe(false);
		expect(out.at(-1)).toEqual(perCall(h.scratch));
	});

	test("superseded head copies and live-state blocks never appear in the tail; other stored messages do", () => {
		const h = head();
		const tailProbe = [userMsg("turn"), assistantText("prose"), developerMsg("stored developer line"), custom("skill-prompt")];
		const dropped = [...LIVE_STATE_CUSTOM_TYPES, RULES_MESSAGE_TYPE, PROCEDURE_SPEC_MESSAGE_TYPE, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE, LEGACY_STATE_MESSAGE_TYPE];
		for (const type of dropped) {
			const out = projected([...h.all, custom(type), ...tailProbe, assistantToolCall("t1"), toolResult("t1", "ok")]);
			// An injected head-type copy can win the head lookup (last of its
			// type), so the claim is over the tail region: the prompt between
			// the core and the scratch copy carries none of the dropped types.
			const tailRegion = out.slice(3, -1);
			expect(tailRegion.some((m) => "customType" in m && m.customType === type)).toBe(false);
			for (const probe of tailProbe) expect(tailRegion.some((m) => m === probe)).toBe(true);
		}
	});
});

// The tail budget the projection computes (the spec formula: the window
// share minus the head's measured bytes and the 32_768-byte reserve);
// eviction's stop target is that budget less one chunk.
function tailBudget(windowTokens: number, headBytes: number) {
	const budget = Math.floor((windowTokens * 4 * DEFAULT_PARAMS.promptBudgetPercent) / 100) - headBytes - 32_768;
	return { budget, chunk: Math.floor((budget * DEFAULT_PARAMS.evictionChunkPercent) / 100) };
}

describe("project tail budget", () => {
	test("an over-budget tail evicts down to the newest message when the budget is zero", () => {
		const h = head();
		const newest = toolResult("t2", "newest");
		const tail = [userMsg("old"), assistantText("old"), assistantToolCall("t1"), toolResult("t1", "x".repeat(2000)), assistantToolCall("t2"), newest];
		// A 1000-token window leaves a negative budget after the head and the
		// reserve: the tail evicts everything but the newest message.
		const out = projected([...h.all, ...tail], 32768, { windowTokens: 1000 });

		expect(out).toHaveLength(5);
		expect(asToolResult(out[3]!).toolCallId).toBe("t2");
		expect(asToolResult(out[3]!).content.slice(1)).toEqual(newest.content);
		expect(out.at(-1)).toEqual(perCall(h.scratch));
	});

	test("evictedCount equals the dropped prefix's length, and the evicted result leaves the tailed results", () => {
		const h = head();
		const tail = [userMsg("old"), assistantText("old"), assistantToolCall("t1"), toolResult("t1", "x".repeat(2000)), assistantToolCall("t2"), toolResult("t2", "newest")];
		// The same zero-budget window as the test above: everything but the
		// newest message evicts, so five of the six tail messages drop.
		const out = project([...h.all, ...tail], [...h.all, ...tail], { ...DEFAULT_PARAMS, observationBytes: 32768 }, 1000);
		if (typeof out === "string" || !("prompt" in out)) throw new Error("expected a projected result");

		expect(out.evictedCount).toBe(5);
		// The dropped t1 result is not tailed: the pairs name exactly the
		// prompt's tagged copies, not the branch's stored results.
		expect(out.tailedResults).toEqual([{ tag: "eb43", toolName: "read" }]);
	});

	test("an over-budget tail settles at or under the budget less one chunk, the newest message still present", () => {
		const h = head();
		const windowTokens = 100_000;
		const { budget, chunk } = tailBudget(windowTokens, h.all.reduce((sum, message) => sum + byteSize(message), 0));
		// Six messages of exactly one chunk each: the drain crosses the
		// ceilings only on whole-chunk steps, so draining to the budget and
		// draining to the budget less a chunk stop one message apart.
		const chunkSized = (): AgentMessage => {
			const base = userMsg("");
			return { role: "user", content: "x".repeat(chunk - byteSize(base)), timestamp: base.timestamp };
		};
		const tail = [chunkSized(), chunkSized(), chunkSized(), chunkSized(), chunkSized(), chunkSized()];

		const out = projected([...h.all, ...tail], 32768, { windowTokens });

		const tailBytes = out.slice(3, -1).reduce((sum, message) => sum + byteSize(message), 0);
		expect(tailBytes).toBeLessThanOrEqual(budget - chunk);
		expect(out[3]).toBe(tail[3]);
		expect(out[5]).toBe(tail[5]);
	});

	test("a tail already under the budget less one chunk is byte-unchanged", () => {
		const h = head();
		const windowTokens = 100_000;
		const { budget, chunk } = tailBudget(windowTokens, h.all.reduce((sum, message) => sum + byteSize(message), 0));
		const tail = [userMsg("older"), assistantText("kept")];
		expect(tail.reduce((sum, message) => sum + byteSize(message), 0)).toBeLessThan(budget - chunk);

		const out = projected([...h.all, ...tail], 32768, { windowTokens });

		expect(out.slice(3, -1)).toEqual(tail);
		expect(out[3]).toBe(tail[0]);
		expect(out[4]).toBe(tail[1]);
	});

	test("a tail both ceilings fit evicts nothing: the survivors match the no-drain layout", () => {
		const h = head();
		const windowTokens = 100_000;
		const { budget, chunk } = tailBudget(windowTokens, h.all.reduce((sum, message) => sum + byteSize(message), 0));
		const tail = [userMsg("a"), assistantText("b"), userMsg("c"), assistantText("d")];
		// Under the old ceiling and the new one alike, so draining to the
		// budget and stopping short of it leave the identical front.
		const totalBytes = tail.reduce((sum, message) => sum + byteSize(message), 0);
		expect(totalBytes).toBeLessThanOrEqual(budget);
		expect(totalBytes).toBeLessThanOrEqual(budget - chunk);

		const out = projected([...h.all, ...tail], 32768, { windowTokens });

		expect(out.slice(3, -1)).toEqual(tail);
	});

	test("a tiny tail over the ceiling keeps the newest message: the one-message floor", () => {
		const h = head();
		const headBytes = h.all.reduce((sum, message) => sum + byteSize(message), 0);
		// A window sized so the budget is ~1200 bytes: positive, but any real
		// tail rides over the ceiling, and the floor holds the newest message.
		const windowTokens = Math.ceil((headBytes + 32_768 + 1200) / ((4 * DEFAULT_PARAMS.promptBudgetPercent) / 100));
		expect(tailBudget(windowTokens, headBytes).budget).toBeGreaterThan(0);
		const tail = [userMsg("old"), assistantToolCall("t9"), toolResult("t9", "y".repeat(2000))];

		const out = projected([...h.all, ...tail], 32768, { windowTokens });

		expect(out).toHaveLength(5);
		expect(asToolResult(out[3]!).toolCallId).toBe("t9");
	});

	test("eviction is chunked: the tail's front holds still across many steps", () => {
		const h = head();
		const branch: AgentMessage[] = [...h.all];
		const fronts: string[] = [];
		for (let step = 1; step <= 60; step++) {
			branch.push(assistantToolCall(`t${step}`), toolResult(`t${step}`, "x".repeat(2000)));
			const out = projected([...branch], 32768, { windowTokens: 100_000 });
			const front = out[3]!;
			fronts.push(front.role === "toolResult" ? asToolResult(front).toolCallId : JSON.stringify(front).slice(0, 40));
		}
		// Per-step eviction would move the front on every step after the first
		// eviction; chunked eviction holds it for runs of steps.
		let longestRun = 1;
		let run = 1;
		let moves = 0;
		for (let i = 1; i < fronts.length; i++) {
			if (fronts[i] === fronts[i - 1]) {
				run++;
				longestRun = Math.max(longestRun, run);
			} else {
				run = 1;
				moves++;
			}
		}
		expect(longestRun).toBeGreaterThanOrEqual(5);
		expect(moves).toBeLessThanOrEqual(12);
	});

	test("the projected prompt stays under the budget and sawtooths at evictions", () => {
		const h = head();
		const windowTokens = 100_000;
		const { budget, chunk } = tailBudget(windowTokens, h.all.reduce((sum, message) => sum + byteSize(message), 0));
		const branch: AgentMessage[] = [...h.all];
		const sizes: number[] = [];
		for (let step = 1; step <= 60; step++) {
			branch.push(assistantToolCall(`t${step}`), toolResult(`t${step}`, "x".repeat(2000)));
			const out = projected([...branch], 32768, { windowTokens });
			const total = out.reduce((sum, message) => sum + byteSize(message), 0);
			// Eviction stops under budget − chunk; each tailed result's tagged
			// copy adds its 13-byte "[#xxxx read]\n" line, and the newest
			// message rides on top, which the per-result cap bounds.
			const tagBytes = 13 * out.filter((message) => message.role === "toolResult").length;
			expect(total).toBeLessThanOrEqual(budget - chunk + byteSize(branch.at(-1)!) + tagBytes);
			sizes.push(total);
		}
		// Sawtooth: at least one eviction drops the prompt by more than one
		// step's growth.
		const stepGrowth = byteSize(assistantToolCall("t")) + byteSize(toolResult("t", "x".repeat(2000)));
		expect(sizes.some((size, i) => i > 0 && sizes[i - 1]! - size > stepGrowth)).toBe(true);
	});

	test("eviction never removes the newest message, however large it is", () => {
		const h = head();
		const huge = toolResult("t1", "x".repeat(50_000));
		// The cap is raised out of the way so the eviction claim stands alone.
		const out = projected([...h.all, userMsg("old"), huge], 1_000_000, { windowTokens: 1000 });

		// The budget is negative at this window, so everything but the newest
		// message evicts; the newest rides however far over it is.
		expect(out).toHaveLength(5);
		expect(asToolResult(out[3]!).toolCallId).toBe("t1");
		expect(asToolResult(out[3]!).content.slice(1)).toEqual(huge.content);
	});
});

describe("project result cap", () => {
	test("an oversized tailed result is capped at observationBytes from the end and carries the marker", () => {
		const h = head();
		const result = toolResult("call-9", "a".repeat(400), "bash");
		const out = projected([...h.all, assistantToolCall("call-9", "bash"), result], 300);
		const capped = asToolResult(out[4]!);
		const marker = capped.content.at(-1)!;

		expect(out[4]).not.toBe(result);
		expect(capped.toolCallId).toBe("call-9");
		expect(marker.type).toBe("text");
		const markerText = marker.type === "text" ? marker.text : "";
		expect(markerText).toMatch(
			/^\[skill-state: result cap 300 bytes exceeded; cut \d+ bytes from the end of this bash result \(call-9\); re-run the tool on a narrower range to read the rest\]$/,
		);
		const cut = Number(markerText.match(/cut (\d+) bytes/)![1]);
		// The tag line is content[0]; the trimmed original text follows it.
		const kept = capped.content[1]!;
		expect(kept.type).toBe("text");
		expect(cut).toBe(400 - Buffer.byteLength(kept.type === "text" ? kept.text : ""));
		expect(textBytes([out[4]!])).toBeLessThanOrEqual(340);
	});

	test("under the cap the stored text passes through behind the tag line", () => {
		const h = head();
		const result = toolResult("t1", "small");
		const out = projected([...h.all, assistantToolCall("t1"), result]);

		expect(out[4]).not.toBe(result);
		expect(asToolResult(out[4]!).content).toEqual([{ type: "text", text: "[#ecd6 read]\n" }, { type: "text", text: "small" }]);
	});

	test("multi-byte UTF-8 is cut on code point boundaries without replacement chars", () => {
		const h = head();
		const result = toolResult("t1", "€".repeat(200));
		const out = projected([...h.all, assistantToolCall("t1"), result], 300);
		const capped = asToolResult(out[4]!);
		const text = capped.content
			.map((b) => (b.type === "text" ? b.text : ""))
			.join("");

		expect(text).not.toContain("�");
		// The floor is one tag line plus one marker; the kept text stays under
		// the cap with the marker the floor forces.
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(340);
	});

	test("the cap is per result: under-cap results never touch it even when the total exceeds it", () => {
		const h = head();
		const r1 = toolResult("t1", "1".repeat(250));
		const r2 = toolResult("t2", "2".repeat(250), "bash");
		const out = projected([...h.all, assistant([
			{ type: "toolCall", id: "t1", name: "read", arguments: {} },
			{ type: "toolCall", id: "t2", name: "read", arguments: {} },
		]), r1, r2], 300)!;

		// Each result fits its own cap, so neither is cut even though the two
		// together exceed 300 bytes: the cap is per result, not cumulative.
		expect(asToolResult(out[4]!).content).toEqual([{ type: "text", text: "[#ecd6 read]\n" }, { type: "text", text: "1".repeat(250) }]);
		expect(asToolResult(out[5]!).content).toEqual([{ type: "text", text: "[#eb43 bash]\n" }, { type: "text", text: "2".repeat(250) }]);
	});

	test("two oversized results are both cut, each to its own cap", () => {
		const h = head();
		const r1 = toolResult("t1", "1".repeat(300));
		const r2 = toolResult("t2", "2".repeat(300), "bash");
		const out = projected([...h.all, assistant([
			{ type: "toolCall", id: "t1", name: "read", arguments: {} },
			{ type: "toolCall", id: "t2", name: "read", arguments: {} },
		]), r1, r2], 150)!;
		const capped1 = asToolResult(out[4]!);
		const capped2 = asToolResult(out[5]!);

		expect(out[4]).not.toBe(r1);
		expect(out[5]).not.toBe(r2);
		const marker1 = capped1.content.at(-1)!;
		const marker2 = capped2.content.at(-1)!;
		expect(marker1.type === "text" && marker1.text).toContain("this read result (t1)");
		expect(marker2.type === "text" && marker2.text).toContain("this bash result (t2)");
		expect(textBytes([capped1])).toBeLessThanOrEqual(190);
		expect(textBytes([capped2])).toBeLessThanOrEqual(190);
	});

	test("below one tag line plus one marker, every result is cut to its floor", () => {
		const h = head();
		const r1 = toolResult("t1", "1".repeat(300));
		const r2 = toolResult("t2", "2".repeat(300), "bash");
		const out = projected([...h.all, assistant([
			{ type: "toolCall", id: "t1", name: "read", arguments: {} },
			{ type: "toolCall", id: "t2", name: "read", arguments: {} },
		]), r1, r2], 30)!;
		const capped = [asToolResult(out[4]!), asToolResult(out[5]!)];

		for (const [i, result] of capped.entries()) {
			expect(result.content).toHaveLength(2);
			const tag = result.content[0]!;
			const tool = i === 0 ? "read" : "bash";
			// The tag line survives the floor: it is what still identifies the
			// result and what the window notice names.
			expect(tag.type === "text" && tag.text).toMatch(new RegExp(`^\\[#\\w{4} ${tool}\\]`));
			const marker = result.content[1]!;
			expect(marker.type === "text" && marker.text).toMatch(new RegExp(`cut \\d+ bytes from the end of this ${tool} result`));
		}
	});

	test("tag bytes count toward the cap: content under the cap alone is over it once tagged", () => {
		const h = head();
		// 290 bytes sits under the 300 cap; the 13-byte tag line pushes it over.
		const out = projected([...h.all, assistantToolCall("t1"), toolResult("t1", "x".repeat(290))], 300)!;
		const capped = asToolResult(out[4]!);

		expect(capped.content[0]).toEqual({ type: "text", text: "[#ecd6 read]\n" });
		expect(capped.content.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("result cap 300 bytes exceeded") });
	});

	test("the tag line composes with truncation: tag stays the first line, marker at the cut end", () => {
		const h = head();
		const out = projected([...h.all, assistantToolCall("call-9", "bash"), toolResult("call-9", "a".repeat(400), "bash")], 300);
		const capped = asToolResult(out[4]!);

		expect(capped.content[0]).toEqual({ type: "text", text: "[#82af bash]\n" });
		const marker = capped.content.at(-1)!;
		expect(marker.type === "text" && marker.text).toContain("result cap 300 bytes exceeded");
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
		const out = projected([...h.all, assistant([
			{ type: "toolCall", id: "t1", name: "read", arguments: {} },
			{ type: "toolCall", id: "t2", name: "bash", arguments: {} },
		]), image, text], 300)!;

		// The image result is tailed too: its projected copy gains the tag
		// line, the image block itself rides uncounted and uncut behind it.
		expect(out[4]).not.toBe(image);
		expect(asToolResult(out[4]!).content[0]).toEqual({ type: "text", text: "[#ecd6 read]\n" });
		expect(asToolResult(out[4]!).content[1]).toEqual({ type: "image", data: "A".repeat(1000), mimeType: "image/png" });
		expect(out[5]).not.toBe(text);
		expect(textBytes([out[5]!])).toBeLessThanOrEqual(340);
	});

	test("project never mutates its input, including under eviction and truncation", () => {
		const truncated = [...head().all, assistantToolCall("t1"), toolResult("t1", "y".repeat(500))];
		const snapshot = structuredClone(truncated);
		projected(truncated, 200);
		expect(truncated).toEqual(snapshot);

		const evicted = [...head().all, userMsg("old"), assistantToolCall("t2"), toolResult("t2", "z")];
		const snapshot2 = structuredClone(evicted);
		projected(evicted, 32768, { windowTokens: 1000 });
		expect(evicted).toEqual(snapshot2);
	});
});

describe("project pair tags", () => {
	test("every tailed result's projected text starts with its pair-tag line, recomputed from the call id alone", () => {
		const h = head();
		const messages: AgentMessage[] = [
			...h.all,
			assistantToolCall("t1"),
			toolResult("t1", "first"),
			assistantToolCall("t2", "bash"),
			toolResult("t2", "second", "bash"),
		];
		const first = projected([...messages]);
		const second = projected([...messages]);
		const tagsOf = (out: AgentMessage[]) => out.filter((m) => m.role === "toolResult").map((m) => asToolResult(m).content[0]);

		// No memo state: the same branch re-derives identical tags.
		expect(tagsOf(second)).toEqual(tagsOf(first));
		expect(tagsOf(first)).toEqual([
			{ type: "text", text: "[#ecd6 read]\n" },
			{ type: "text", text: "[#eb43 bash]\n" },
		]);
	});

	test("tailedResults are the prompt's tagged tool results, oldest first, tag and tool name each", () => {
		const h = head();
		const messages = [...h.all, assistantToolCall("t1"), toolResult("t1", "first"), assistantToolCall("t2", "bash"), toolResult("t2", "second", "bash")];
		const out = project(messages, messages, { ...DEFAULT_PARAMS, observationBytes: 32768 }, undefined);
		if (typeof out === "string" || !("prompt" in out)) throw new Error("expected a projected result");

		// The known tags of t1 and t2, in tail order with their tool names.
		expect(out.tailedResults).toEqual([
			{ tag: "ecd6", toolName: "read" },
			{ tag: "eb43", toolName: "bash" },
		]);
		// The same pairs the prompt's tagged copies open with, in prompt order.
		const tagged = out.prompt.filter((m) => m.role === "toolResult").map((m) => {
			const result = asToolResult(m);
			const first = result.content[0]!;
			const tag = first.type === "text" && first.text.startsWith("[#") ? first.text.slice(2, 6) : "";
			return { tag, toolName: result.toolName };
		});
		expect(out.tailedResults).toEqual(tagged);
	});

	test("stored tool results pass through untouched: the projection copies, never mutates", () => {
		const h = head();
		const stored = toolResult("t1", "x");
		const snapshot = structuredClone(stored);

		projected([...h.all, assistantToolCall("t1"), stored]);

		expect(stored).toEqual(snapshot);
	});
});

describe("project result object", () => {
	test("a projected step returns one result object carrying prompt, tailedResults and evictedCount, never a bare array", () => {
		const h = head();
		const messages = [...h.all, userMsg("turn"), assistantText("prose")];
		const out = project(messages, messages, { ...DEFAULT_PARAMS, observationBytes: 32768 }, undefined);

		expect(Array.isArray(out)).toBe(false);
		if (typeof out === "string" || !("prompt" in out)) throw new Error(`expected a projected result, got ${JSON.stringify(out)}`);
		expect(out.prompt[0]).toBe(h.rules);
		expect(Array.isArray(out.tailedResults)).toBe(true);
		expect(typeof out.evictedCount).toBe("number");
		// A tail without tool results tails nothing and evicts nothing.
		expect(out.tailedResults).toEqual([]);
		expect(out.evictedCount).toBe(0);
	});
});

describe("project degradation and fallback", () => {
	// The degraded branch of project: the head is intact but nothing is
	// stored behind it. The projection returns the head and never history.
	function degraded(messages: AgentMessage[]): { head: AgentMessage[] } {
		const out = project(messages, messages, { ...DEFAULT_PARAMS }, undefined);
		if (typeof out === "string") throw new Error(`expected a degraded projection, got the failure ${out}`);
		if (!("head" in out)) throw new Error("expected a degraded projection, got a projected result");
		return out;
	}

	test("a head with nothing stored behind it degrades to the head alone", () => {
		const h = head();
		const out = degraded([...h.all]);

		expect(out.head).toEqual([h.rules, h.procedureSpec, h.core, perCall(h.scratch)]);
		expect(out.head[0]).toBe(h.rules);
		expect(out.head[3]).toEqual(perCall(h.scratch));
	});

	test("live-state blocks behind the head leave the tail empty: still degraded", () => {
		const h = head();
		const out = degraded([...h.all, custom("goal-mode-context"), custom("ttsr-injection")]);

		expect(out.head).toEqual([h.rules, h.procedureSpec, h.core, perCall(h.scratch)]);
	});

	test("a missing head message fails the projection as incomplete-head", () => {
		const complete = [...head().all, userMsg("turn")];
		for (const drop of [0, 1, 2, 3]) {
			const short = complete.filter((_, i) => i !== drop);
			expect(project(short, short, { ...DEFAULT_PARAMS }, undefined)).toBe("incomplete-head");
		}
	});

	test("a legacy single state message never completes the head: the projection reports incomplete-head", () => {
		const h = head();
		const legacy = [...h.all.slice(0, 2), custom(LEGACY_STATE_MESSAGE_TYPE, "{}", { state: { goal: "x" } })];
		const withLegacy = [...legacy, userMsg("turn")];
		expect(project(withLegacy, withLegacy, { ...DEFAULT_PARAMS }, undefined)).toBe("incomplete-head");
		const mixed = [...h.all.slice(0, 2), h.core, legacy[2]!, userMsg("turn")];
		expect(project(mixed, mixed, { ...DEFAULT_PARAMS }, undefined)).toBe("incomplete-head");
	});
});
