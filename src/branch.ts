import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { PROCEDURE_SPEC_MESSAGE_TYPE, extractStatePayload, isStateCoreMessage, isStateScratchMessage, skillInvocationName } from "./messages";
import { isPlainObject } from "./state";
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
}

// The state pairs (CONTEXT.md "State pair") stored on the given entries, in
// order: a scratch closes the pair its preceding core opened, and a message
// whose payload is gone — an elide-pass placeholder — never completes a
// pair. The writer (procedure.ts stateMessages) is the only producer of
// the order; this read is its one consumer-side home, so re-derive and the
// test session cannot drift apart on the pairing rule. Pure: what to do with
// the pairs — keep the last, keep all, gate on completeness — is the
// caller's.
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

// The re-derive rule: the latest user invocation of a procedure skill,
// followed by its procedure-spec message and state pairs (CONTEXT.md "State
// pair") that are complete to the end — every state message in the
// invocation's segment belongs to a pair — is a procedure engaged with the
// last pair's merged state; anything less is inert. A damaged or trailing
// state message never falls back to an earlier pair (spec section 14). The
// partitions are disjoint by construction, so the merge is {...core,
// ...scratch}; scratch wins only if a legacy overlap exists. Pure: what to do
// with the answer (load the schema, engage, disengage) is the caller's.
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
	for (const entry of segment) {
		if (entry.type !== "custom_message") continue;
		if (entry.customType === PROCEDURE_SPEC_MESSAGE_TYPE) spec = contentText(entry.content);
		else if (isStateCoreMessage(entry) || isStateScratchMessage(entry)) stateMessages++;
	}
	const pairs = statePairs(segment);
	if (spec === undefined || pairs.length === 0 || stateMessages !== pairs.length * 2) return undefined;
	const { core, scratch } = pairs[pairs.length - 1]!;
	return { name, spec, state: { ...core, ...scratch } };
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
