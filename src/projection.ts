import { newestByStamp } from "./branch";
import { LEGACY_STATE_MESSAGE_TYPE, LIVE_STATE_CUSTOM_TYPES, PROCEDURE_SPEC_MESSAGE_TYPE, RULES_MESSAGE_TYPE, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE, extractStateStamp } from "./messages";
import type { StateParams } from "./state";
import { isPlainObject } from "./types";
import type { AgentMessage, ProjectionFailure } from "./types";

type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;
type ResultContent = ToolResult["content"];

// A degraded step's projection (ADR 0005, narrowed by ADR 0010): the stored
// head is intact but nothing tail-eligible is stored behind it, so the step
// runs on the head alone. The head messages are the stored byte-stable ones,
// so the cache ceiling is unchanged. Never ordinary history.
export interface DegradedProjection {
	head: AgentMessage[];
}

// The window read, in tokens, when ctx.getContextUsage() gives no usable
// number (no model yet, or a zero window): the common large-context tier, so
// the budget errs toward keeping more of the tail rather than evicting it.
const FALLBACK_CONTEXT_WINDOW_TOKENS = 200_000;

// Bytes per token for the window-to-bytes conversion: the conventional
// English-prose figure of four bytes (~one token each). The budget only needs
// a stable proxy, not an exact tokenizer.
const BYTES_PER_TOKEN = 4;

// The byte share of the budget held back for everything the projection does
// not measure: the harness's system prompt, the tool declarations and the
// reply the model is about to produce. Without it the tail would crowd them
// out of the window.
const TAIL_RESERVE_BYTES = 32_768;

// Head lookup: the last stored message of a head type wins; earlier ones are
// superseded and dropped.
function lastCustom(messages: readonly AgentMessage[], customType: string): AgentMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "custom" && message.customType === customType) return message;
	}
	return undefined;
}

// The state halves pick by write stamp first, branch position as the final
// tiebreak (ADR 0012): a parked next-turn send of an older commit landing
// after the newer pair must not time-travel the prompt. Rules and spec keep
// the positional-last lookup above.
function lastStateCustom(messages: readonly AgentMessage[], customType: string): AgentMessage | undefined {
	const isStateHalf = (message: AgentMessage): message is Extract<AgentMessage, { role: "custom" }> => message.role === "custom" && message.customType === customType;
	return newestByStamp(messages.filter(isStateHalf), (message) => extractStateStamp(message.details));
}

// Pair tag (CONTEXT.md): four lowercase hex digits, FNV-1a over the tool call
// id's UTF-8 bytes. A pure function of the id alone, so a re-derive or rewind
// recomputes identical tags with no memo state.
export function pairTag(toolCallId: string): string {
	let hash = 0x811c9dc5;
	for (const byte of Buffer.from(toolCallId, "utf8")) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash & 0xffff).toString(16).padStart(4, "0");
}

// The pair-tag line prepended to each projected tailed result. Only the
// projected copy is modified; the stored result never carries the tag.
function taggedResult(result: ToolResult): ToolResult {
	return { ...result, content: [{ type: "text", text: `[#${pairTag(result.toolCallId)} ${result.toolName}]\n` }, ...result.content] };
}

// The head's spine: the one head message sent only at engage and after a
// compaction. The tail starts after the newest spine custom. The rules do
// not anchor the cut: `before_agent_start` re-sends rules on any mid-run
// batch announcing a procedure skill, while no new spec lands while engaged
// (the message_end engage path early-returns), so a rules anchor would move
// the cut behind a mid-run invocation's own user turn and skill prompt and
// hide them from the model — the blindness ADR 0010 removes. The commit
// pairs (core, scratch) land on the branch at every step boundary, so
// cutting after the newest of those would restart the tail each step; a
// re-sent head after a compaction still bounds it.
const TAIL_SPINE_TYPES: Record<string, true> = { [PROCEDURE_SPEC_MESSAGE_TYPE]: true };

// The customs that never enter the tail, wherever they sit on the branch: the
// head's own message types (older superseded copies, re-sent copies, commit
// pairs) and the injected live-state blocks.
const TAIL_EXCLUDED_TYPES: Record<string, true> = Object.assign(Object.create(null), {
	[RULES_MESSAGE_TYPE]: true,
	[PROCEDURE_SPEC_MESSAGE_TYPE]: true,
	[STATE_CORE_MESSAGE_TYPE]: true,
	[STATE_SCRATCH_MESSAGE_TYPE]: true,
	[LEGACY_STATE_MESSAGE_TYPE]: true,
	...Object.fromEntries(LIVE_STATE_CUSTOM_TYPES.map((type) => [type, true as const])),
});

// The stored messages the tail is built from: everything on the branch after
// the newest spine custom (positional cut), minus the excluded customs above.
// Everything else is tail-eligible: user turns, assistant text and tool
// calls, tool results, skill-prompt customs, state_update calls and results.
function tailCandidates(branch: readonly AgentMessage[]): AgentMessage[] {
	let start = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		const message = branch[i]!;
		if (message.role === "custom" && message.customType in TAIL_SPINE_TYPES) {
			start = i + 1;
			break;
		}
	}
	const candidates: AgentMessage[] = [];
	for (let i = start; i < branch.length; i++) {
		const message = branch[i]!;
		if (message.role === "custom" && message.customType in TAIL_EXCLUDED_TYPES) continue;
		candidates.push(message);
	}
	return candidates;
}

// Whole-message byte size, the proxy every budget measure below uses.
function messageBytes(message: AgentMessage): number {
	return Buffer.byteLength(JSON.stringify(message));
}

// Chunked eviction (ADR 0011): while the tail is over the budget less one
// chunk, drop the oldest messages in one chunk's worth at a time, so the
// front holds still across many steps and the cached prefix survives
// between evictions; the chunk of headroom is the ceiling from issue #40. The
// newest message is never dropped, so a prompt may exceed the budget by the
// newest message's size; the per-result cap bounds that excess.
function evictOldest(candidates: readonly AgentMessage[], budget: number, chunk: number): AgentMessage[] {
	const sizes = candidates.map(messageBytes);
	let total = sizes.reduce((sum, size) => sum + size, 0);
	let start = 0;
	while (total > budget - chunk && candidates.length - start > 1) {
		// One chunk from the front, at least one message so a zero chunk
		// cannot stall the eviction.
		let chunkBytes = 0;
		let end = start;
		do {
			chunkBytes += sizes[end]!;
			end++;
		} while (end < candidates.length - 1 && chunkBytes < chunk);
		start = end;
		total -= chunkBytes;
	}
	return candidates.slice(start);
}

interface CutPlan {
	position: number;
	result: ToolResult;
}

// Builds the projected prompt: rules, P, the state core, the tail, the
// scratch state (ADR 0011's order — the cached prefix reaches through the
// tail's stable front). Rules, P and the core are the stored objects
// themselves, which keeps them byte-equal to history. The scratch rides as a
// deliberately differing copy: one extra field in details, outside the
// model-visible role and content, makes the harness mark it per-call; the
// durable breakpoint anchors on the newest stable message before the first
// per-call one — normally the tail's first tagged tool result, not this
// copy. The
// tail is read from the branch, so a harness compaction cut cannot shorten
// it. A ProjectionFailure return means no projection: the call gets ordinary
// context. That is the safe fallback whenever the head is incomplete; a wrong
// prompt is worse than a plain one, and the reason is what the fallback
// notice quotes. A DegradedProjection return keeps the head and drops the
// tail: while the head is intact the projection never falls back to ordinary
// history (ADR 0005).
export function project(
	messages: readonly AgentMessage[],
	branch: readonly AgentMessage[],
	params: Pick<StateParams, "observationBytes" | "promptBudgetPercent" | "evictionChunkPercent">,
	contextWindowTokens: number | undefined,
): AgentMessage[] | ProjectionFailure | DegradedProjection {
	const rules = lastCustom(messages, RULES_MESSAGE_TYPE);
	const procedureSpec = lastCustom(messages, PROCEDURE_SPEC_MESSAGE_TYPE);
	const core = lastStateCustom(messages, STATE_CORE_MESSAGE_TYPE);
	const scratchStored = lastStateCustom(messages, STATE_SCRATCH_MESSAGE_TYPE);
	// Both state messages or inert; the stored pairing rule behind that has
	// its one home in branch.ts (statePairs) — this is the presence check over
	// the projected message list, a different shape, not a second walker.
	if (rules === undefined || procedureSpec === undefined || core === undefined || scratchStored === undefined || scratchStored.role !== "custom") {
		return "incomplete-head";
	}
	const storedDetails = scratchStored.details;
	const scratchCopy: AgentMessage = {
		...scratchStored,
		details: { ...(isPlainObject(storedDetails) ? storedDetails : {}), perCall: true },
	};
	const degraded: DegradedProjection = { head: [rules, procedureSpec, core, scratchCopy] };

	const candidates = tailCandidates(branch);
	if (candidates.length === 0) return degraded;

	// The tail budget (CONTEXT.md "Prompt budget"): the budget percent of the
	// window, minus the head, the scratch and the reserve. Both sums use the
	// same whole-message JSON bytes the eviction measures.
	const windowTokens = contextWindowTokens !== undefined && contextWindowTokens > 0 ? contextWindowTokens : FALLBACK_CONTEXT_WINDOW_TOKENS;
	const windowBytes = windowTokens * BYTES_PER_TOKEN;
	const budget = Math.max(
		0,
		Math.floor((windowBytes * params.promptBudgetPercent) / 100) - messageBytes(rules) - messageBytes(procedureSpec) - messageBytes(core) - messageBytes(scratchStored) - TAIL_RESERVE_BYTES,
	);
	const chunk = Math.floor((budget * params.evictionChunkPercent) / 100);

	const tail = evictOldest(candidates, budget, chunk);
	// Tag bytes ride before the cap: the tailed results are the tagged copies,
	// and each result's own cap sees the tag line as part of it.
	const capped: CutPlan[] = [];
	const tailParts = tail.map((message, position) => {
		if (message.role !== "toolResult") return message;
		const tagged = taggedResult(message);
		capped.push({ position, result: tagged });
		return tagged;
	});
	const tailCapped = capResults(tailParts, capped, params.observationBytes);
	return [rules, procedureSpec, core, ...tailCapped, scratchCopy];
}

// Each tailed result's own text is capped at `cap` (per result, not
// cumulative). Over the cap, the result is cut from the end and a marker
// naming the cut is appended. Neither the marker nor the pair-tag line is
// ever cut: the cap's floor is one tag line plus one marker.
function capResults(tail: AgentMessage[], plans: CutPlan[], cap: number): AgentMessage[] {
	const materialised = [...tail];
	for (const plan of plans) {
		const bytes = textBlockBytes(plan.result.content);
		if (bytes <= cap) continue;
		// The tag line is content[0] and never cut; its bytes count toward
		// the cap. The marker's size depends on the cut it names, so the
		// plan budgets the largest marker the cut could need; the real
		// marker is never bigger, so the total lands at or under the cap.
		const tagBytes = firstBlockBytes(plan.result.content);
		const text = bytes - tagBytes;
		const markerUpper = Buffer.byteLength(cutMarker(cap, text, plan.result));
		let keep = cap - tagBytes - markerUpper;
		if (keep < 0) keep = 0;
		const trimmed = cutTextEnd(plan.result.content, text - keep, 1);
		const marker = cutMarker(cap, trimmed.cut, plan.result);
		materialised[plan.position] = { ...plan.result, content: [...trimmed.content, { type: "text", text: marker }] };
	}
	return materialised;
}

function textBlockBytes(content: ResultContent): number {
	let total = 0;
	for (const block of content) {
		if (block.type === "text") total += Buffer.byteLength(block.text);
	}
	return total;
}

// Byte length of the result's first content block when it is text — the
// pair-tag line taggedResult prepended. The cap never cuts it.
function firstBlockBytes(content: ResultContent): number {
	const block = content[0];
	return block !== undefined && block.type === "text" ? Buffer.byteLength(block.text) : 0;
}

// Model-facing marker: names what was cut and how to re-read it.
function cutMarker(cap: number, cut: number, result: ToolResult): string {
	return `[skill-state: result cap ${cap} bytes exceeded; cut ${cut} bytes from the end of this ${result.toolName} result (${result.toolCallId}); re-run the tool on a narrower range to read the rest]`;
}

// Remove up to cutBytes of UTF-8 text from the end of the content blocks, last
// block first. Blocks before protectedBlocks are never cut. Cuts land on code
// point boundaries, so the kept text never ends in a replacement character.
// Returns a new array; never mutates the input.
function cutTextEnd(content: ResultContent, cutBytes: number, protectedBlocks = 0): { content: ResultContent; cut: number } {
	const blocks = [...content];
	let remaining = cutBytes;
	for (let i = blocks.length - 1; i >= protectedBlocks && remaining > 0; i--) {
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
