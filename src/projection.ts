import { RULES_MESSAGE_TYPE, PROCEDURE_SPEC_MESSAGE_TYPE, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE } from "./messages";
import { isPlainObject } from "./state";
import type { AgentMessage } from "./types";

type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;
type ResultContent = ToolResult["content"];

interface CutPlan {
	position: number;
	result: ToolResult;
	remaining: number;
	cut: number;
}

// Head lookup: the last stored message of a head type wins; earlier ones are
// superseded and dropped.
function lastCustom(messages: readonly AgentMessage[], customType: string): AgentMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "custom" && message.customType === customType) return message;
	}
	return undefined;
}

// Customs and developer messages are either head messages, the skill prompt or
// live-state blocks; none belong to the current step's tail.
function isSkippable(message: AgentMessage): boolean {
	return message.role === "custom" || message.role === "developer";
}

// Builds the projected prompt: head (rules, P, state core, scratch state)
// plus the current step. Rules, P and the core are the stored objects
// themselves, which keeps them byte-equal to history and lets the provider's
// cache prefix reach through the core. The scratch rides as a deliberately
// differing copy: one extra field in details, outside the model-visible role
// and content, makes the harness mark it per-call so the durable breakpoint
// anchors on the newest stable message before it, the last core message.
// undefined means no projection: the call gets ordinary context. That is the
// safe fallback whenever the head is incomplete or provider pairing cannot be
// established; a wrong prompt is worse than a plain one.
export function project(messages: readonly AgentMessage[], observationBytes: number, observationWindow = 1): AgentMessage[] | undefined {
	const rules = lastCustom(messages, RULES_MESSAGE_TYPE);
	const procedureSpec = lastCustom(messages, PROCEDURE_SPEC_MESSAGE_TYPE);
	const core = lastCustom(messages, STATE_CORE_MESSAGE_TYPE);
	const scratchStored = lastCustom(messages, STATE_SCRATCH_MESSAGE_TYPE);
	if (rules === undefined || procedureSpec === undefined || core === undefined || scratchStored === undefined || scratchStored.role !== "custom") {
		return undefined;
	}
	const storedDetails = scratchStored.details;
	const scratchCopy: AgentMessage = {
		...scratchStored,
		details: { ...(isPlainObject(storedDetails) ? storedDetails : {}), perCall: true },
	};
	const head: AgentMessage[] = [rules, procedureSpec, core, scratchCopy];

	let end = messages.length;
	while (end > 0 && isSkippable(messages[end - 1]!)) end--;
	if (end === 0) return head;

	const last = messages[end - 1]!;
	if (last.role === "toolResult") {
		// Walk back over the observation window's tool pairs, newest first. The
		// newest pair is mandatory: any pairing failure there leaves the call
		// unprojected. An unpairable older pair only ends the walk, keeping the
		// pairs collected before it.
		const pairs: AgentMessage[][] = [];
		let cursor = end;
		for (let collected = 0; collected < observationWindow; collected++) {
			const results: ToolResult[] = [];
			let pinned: AgentMessage | undefined;
			for (let i = cursor - 1; i >= 0; i--) {
				const message = messages[i]!;
				if (message.role === "toolResult") {
					results.unshift(message);
					continue;
				}
				if (isSkippable(message)) continue;
				pinned = message;
				cursor = i;
				break;
			}
			// Every result must answer a toolCall block in the assistant message
			// right before it; that is what keeps provider pairing intact without
			// repair. Otherwise fall back to no projection. A call that never got
			// a result is a history condition the harness handles on its own, so
			// it is not checked.
			if (results.length === 0 || pinned?.role !== "assistant") {
				if (collected === 0) return undefined;
				break;
			}
			const callIds = new Set(pinned.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])));
			if (results.some((result) => !callIds.has(result.toolCallId))) {
				if (collected === 0) return undefined;
				break;
			}
			pairs.push([pinned, ...results]);
		}
		const window: AgentMessage[] = [];
		for (let i = pairs.length - 1; i >= 0; i--) window.push(...pairs[i]!);
		return [...head, ...capObservation(window, observationBytes)];
	}
	if (last.role === "user") {
		// Human answers are anaphoric ("agree with your recommendation"), so
		// the user turn rides with the assistant message immediately before
		// it as its antecedent; one message bounds the turn, and once the
		// agent acts on the answer the next step's observation is a tool
		// result and the exchange rotates out.
		const turn: AgentMessage[] = [];
		let cursor = end - 1;
		while (cursor >= 0) {
			const message = messages[cursor]!;
			if (message.role === "user") turn.unshift(message);
			else if (!isSkippable(message)) break;
			cursor--;
		}
		// Notices between the batch and its antecedent do not break the pair.
		while (cursor >= 0 && isSkippable(messages[cursor]!)) cursor--;
		if (cursor >= 0 && messages[cursor]!.role === "assistant") turn.unshift(messages[cursor]!);
		return [...head, ...turn];
	}
	// A trailing assistant message has no observation yet.
	return head;
}

// The cap bounds the step's combined observation text, tool results only. The
// user turn and the pinned assistant message are never cut; non-text blocks are
// neither counted nor cut. Under the cap nothing changes, so results keep their
// identity. Over it, the largest result is cut from the end, then the next
// largest, until the total including the markers fits.
function capObservation(tail: AgentMessage[], cap: number): AgentMessage[] {
	const plans: CutPlan[] = [];
	let total = 0;
	for (let i = 0; i < tail.length; i++) {
		const message = tail[i]!;
		if (message.role !== "toolResult") continue;
		const remaining = textBlockBytes(message.content);
		plans.push({ position: i, result: message, remaining, cut: 0 });
		total += remaining;
	}
	if (total <= cap) return tail;

	// Plan on byte counts, then materialise each cut result once. The marker
	// names the cut, so its size depends on the cut; the plan budgets the largest
	// marker the result could need, and the real marker is never bigger, so the
	// total lands at or under the cap. A partial cut ends the loop; a full cut
	// moves on to the next largest result, so no result is cut twice.
	while (total > cap) {
		let pick: CutPlan | undefined;
		for (const plan of plans) {
			if (plan.remaining > 0 && (pick === undefined || plan.remaining > pick.remaining)) pick = plan;
		}
		// Only markers are left. They are the whole observation now and the only
		// record of what was cut, so they are never cut themselves: the floor of
		// the cap is one marker per result.
		if (pick === undefined) break;
		const markerBytes = Buffer.byteLength(cutMarker(cap, pick.remaining, pick.result));
		const cut = Math.min(pick.remaining, total - cap + markerBytes);
		pick.cut += cut;
		pick.remaining -= cut;
		total += markerBytes - cut;
	}

	const capped = [...tail];
	for (const { position, result, cut } of plans) {
		if (cut === 0) continue;
		const trimmed = cutTextEnd(result.content, cut);
		const marker = cutMarker(cap, trimmed.cut, result);
		capped[position] = { ...result, content: [...trimmed.content, { type: "text", text: marker }] };
	}
	return capped;
}

function textBlockBytes(content: ResultContent): number {
	let total = 0;
	for (const block of content) {
		if (block.type === "text") total += Buffer.byteLength(block.text);
	}
	return total;
}

// Model-facing marker: names what was cut and how to re-read it.
function cutMarker(cap: number, cut: number, result: ToolResult): string {
	return `[skill-state: observation cap ${cap} bytes exceeded; cut ${cut} bytes from the end of this ${result.toolName} result (${result.toolCallId}); re-run the tool on a narrower range to read the rest]`;
}

// Remove up to cutBytes of UTF-8 text from the end of the content blocks, last
// block first. Cuts land on code point boundaries, so the kept text never ends
// in a replacement character. Returns a new array; never mutates the input.
function cutTextEnd(content: ResultContent, cutBytes: number): { content: ResultContent; cut: number } {
	const blocks = [...content];
	let remaining = cutBytes;
	for (let i = blocks.length - 1; i >= 0 && remaining > 0; i--) {
		const block = blocks[i]!;
		if (block.type !== "text") continue;
		const bytes = Buffer.byteLength(block.text);
		if (bytes <= remaining) {
			blocks.splice(i, 1);
			remaining -= bytes;
			continue;
		}
		const encoded = Buffer.from(block.text, "utf8");
		let keep = encoded.length - remaining;
		while (keep > 0 && (encoded[keep]! & 0xc0) === 0x80) keep--;
		blocks[i] = { ...block, text: encoded.subarray(0, keep).toString("utf8") };
		remaining -= encoded.length - keep;
	}
	return { content: blocks, cut: cutBytes - remaining };
}
