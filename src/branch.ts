import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { PROCEDURE_SPEC_MESSAGE_TYPE, STATE_MIRROR_ENTRY_TYPE, extractMirrorPayload, extractStatePayload, extractStateStamp, isStateCoreMessage, isStateScratchMessage, renderStateContent, skillInvocationName } from "./messages";
import type { StateMirror } from "./messages";
import { isPlainObject } from "./types";
import type { AgentMessage } from "./types";
import { stateEquals } from "./state";
import type { ExecutionState } from "./state";

// Custom message content is a string or text blocks; the invocation's P is
// taken from and the stored P is read back through the same path.
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.flatMap((block) => (isPlainObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
			.join("\n");
	}
	return String(content);
}

export interface ProcedureOnBranch {
	name: string;
	spec: string;
	state: ExecutionState;
	// True when a mirror exists and the newest stored state messages disagree
	// with it: re-derive repairs by re-sending the head (ADR 0012). No
	// mirror, no repair.
	needsRepair: boolean;
	// The effective source's write stamp, seeding the engaged record so its
	// next commit orders above everything already on the branch.
	stamp: number;
}

// The state pairs (CONTEXT.md "State pair") stored on the given entries, in
// order: a scratch closes the pair its preceding core opened, and a message
// whose payload is gone — an elide-pass placeholder — never completes a
// pair. The writer (procedure.ts stateMessages) is the only producer of the
// order; this read is its one consumer-side home, so re-derive and the test
// session cannot drift apart on the pairing rule. Pure: what to do with the
// pairs — keep the last, keep all, gate on completeness — is the caller's.
export function statePairs(entries: readonly SessionEntry[]): Array<{ core: ExecutionState; scratch: ExecutionState }> {
	const pairs: Array<{ core: ExecutionState; scratch: ExecutionState }> = [];
	let core: ExecutionState | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom_message") continue;
		if (isStateCoreMessage(entry)) {
			const state = extractStatePayload(entry.details);
			if (state !== undefined) core = state;
		} else if (isStateScratchMessage(entry)) {
			const state = extractStatePayload(entry.details);
			if (state !== undefined && core !== undefined) {
				pairs.push({ core, scratch: state });
				core = undefined;
			}
		}
	}
	return pairs;
}

// The positional log of durable mirrors (ADR 0012): every mirror entry's
// payload, in branch order; entries whose data is not a mirror shape are
// skipped. Pure: ordering and the repair verdict are the caller's.
export function stateMirrors(entries: readonly SessionEntry[]): StateMirror[] {
	const mirrors: StateMirror[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STATE_MIRROR_ENTRY_TYPE) continue;
		const mirror = extractMirrorPayload(entry.data);
		if (mirror !== undefined) mirrors.push(mirror);
	}
	return mirrors;
}

// The highest write stamp any stored state message or mirror carries, 0 when
// none does. A fresh engage seeds it, so the new run's head ties the newest
// stored copy and beats it on the later position, and its first commit
// orders above everything — an ended run's stamped copies must not win the
// prompt of the run that replaced them (the ordering of ADR 0012).
export function highestStamp(entries: readonly SessionEntry[]): number {
	let highest = 0;
	for (const entry of entries) {
		if (entry.type === "custom_message" && (isStateCoreMessage(entry) || isStateScratchMessage(entry))) highest = Math.max(highest, extractStateStamp(entry.details));
		else if (entry.type === "custom" && entry.customType === STATE_MIRROR_ENTRY_TYPE) highest = Math.max(highest, extractMirrorPayload(entry.data)?.stamp ?? 0);
	}
	return highest;
}

// The stored state message a pick reads: its details (the payload and write
// stamp) and its content, both as the runtime wrote them.
interface StoredStateMessage {
	details?: unknown;
	content?: unknown;
}

// The item with the highest write stamp (CONTEXT.md "Write stamp"); equal
// stamps keep the last position, so branch position is the final tiebreak and
// a parked older send landing after a newer commit never time-travels the
// read (ADR 0012's ordering). An item whose stamp is missing reads as 0.
export function newestByStamp<T>(items: readonly T[], stampOf: (item: T) => number): T | undefined {
	let best: T | undefined;
	let bestStamp = -1;
	for (const item of items) {
		const stamp = stampOf(item);
		if (stamp >= bestStamp) {
			best = item;
			bestStamp = stamp;
		}
	}
	return best;
}

// A stored state message disagrees with its mirror partition when either its
// payload or its rendered content was rewritten (ADR 0012 names the
// content): the elide pass can leave the payload and replace the text.
function disagrees(entry: StoredStateMessage | undefined, partition: ExecutionState): boolean {
	if (entry === undefined) return true;
	if (!stateEquals(extractStatePayload(entry.details) ?? {}, partition)) return true;
	return contentText(entry.content) !== renderStateContent(partition);
}

// The re-derive rule: the latest user invocation of a procedure skill,
// followed by its procedure-spec message and state pairs (CONTEXT.md "State
// pair") that are complete to the end — every state message in the
// invocation's segment belongs to a pair — is a procedure engaged with the
// newest state. The newest mirror is the effective state (ADR 0012); without
// mirrors it is the newest pair's merge. Newest means highest write stamp,
// branch position as the final tiebreak; a missing stamp reads as 0. A
// damaged or trailing state message never falls back to an earlier pair
// (spec section 14). The partitions are disjoint by construction, so the
// merge is {...core, ...scratch}; scratch wins only if a legacy overlap
// exists. Pure: what to do with the answer (load the schema, engage,
// disengage) is the caller's.
export function scanBranch(entries: readonly SessionEntry[]): ProcedureOnBranch | undefined {
	let name: string | undefined;
	let start = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "custom_message") continue;
		const invoked = skillInvocationName(entry);
		if (invoked !== undefined) {
			name = invoked;
			start = i;
			break;
		}
	}
	if (name === undefined) return undefined;
	const segment = entries.slice(start + 1);
	let spec: string | undefined;
	let stateMessages = 0;
	const cores: StoredStateMessage[] = [];
	const scratches: StoredStateMessage[] = [];
	for (const entry of segment) {
		if (entry.type !== "custom_message") continue;
		if (entry.customType === PROCEDURE_SPEC_MESSAGE_TYPE) spec = contentText(entry.content);
		else if (isStateCoreMessage(entry)) {
			stateMessages++;
			if (extractStatePayload(entry.details) !== undefined) cores.push(entry);
		} else if (isStateScratchMessage(entry)) {
			stateMessages++;
			if (extractStatePayload(entry.details) !== undefined) scratches.push(entry);
		}
	}
	const pairs = statePairs(segment);
	if (spec === undefined || pairs.length === 0 || stateMessages !== pairs.length * 2) return undefined;
	const storedCore = newestByStamp(cores, (e) => extractStateStamp(e.details));
	const storedScratch = newestByStamp(scratches, (e) => extractStateStamp(e.details));
	// The completeness gate above guarantees both newest picks exist (a pair
	// needs a closed core and scratch), so the non-null assertions and the
	// payload reads below cannot miss.
	const mirrors = stateMirrors(segment);
	const mirror = newestByStamp(mirrors, (m) => m.stamp);
	if (mirror !== undefined) {
		return {
			name,
			spec,
			state: { ...mirror.core, ...mirror.scratch },
			needsRepair: disagrees(storedCore, mirror.core) || disagrees(storedScratch, mirror.scratch),
			stamp: mirror.stamp,
		};
	}
	const core = extractStatePayload(storedCore!.details)!;
	const scratch = extractStatePayload(storedScratch!.details)!;
	return { name, spec, state: { ...core, ...scratch }, needsRepair: false, stamp: extractStateStamp(storedCore!.details) };
}

// The compaction cut: the latest assistant message on the branch, i.e. the
// start of the current step, so the kept tail is exactly the step the next
// projection pins (its tool results follow it). The harness's own cut keeps a
// turn-sized tail the projection never sends but the harness still counts; a
// tail still over its recovery band makes it "rescue" the compaction with an
// elide pass that rewrites kept entries in place, the state messages included.
export function currentStepCut(entries: readonly SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type === "message" && entry.message?.role === "assistant") return entry.id;
	}
	return undefined;
}

// The branch as the message list the projection tails: message entries pass
// their message through, custom_message entries become the custom messages
// the context event would carry — `attribution` included, exactly as the
// harness's own entry→message conversion restores it, so a projected stored
// custom stays byte-equal to its harness counterpart and the prefix cache
// holds. The tail reads the branch rather than the context event's list, so
// a harness compaction cut cannot shorten it.
export function branchMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "message") messages.push(entry.message);
		else if (entry.type === "custom_message") {
			messages.push({ role: "custom", customType: entry.customType, content: entry.content, display: entry.display, timestamp: Date.parse(entry.timestamp), ...(entry.details === undefined ? {} : { details: entry.details }), ...(entry.attribution === undefined ? {} : { attribution: entry.attribution }) } as AgentMessage);
		}
	}
	return messages;
}
