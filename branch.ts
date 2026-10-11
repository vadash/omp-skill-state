import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { PROCEDURE_SPEC_MESSAGE_TYPE, STATE_MESSAGE_TYPE } from "./messages";
import { isPlainObject } from "./state";
import type { ExecutionState } from "./state";

// The harness's own message type for a skill invocation; a user-attributed one
// is what starts a procedure.
export const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";

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

// The re-derive rule: the latest user invocation of a procedure skill, followed
// by its procedure-spec message and a state message, is a procedure engaged
// with that state; anything less is inert. Pure: what to do with the answer
// (load the schema, engage, disengage) is the caller's.
export function scanBranch(entries: readonly SessionEntry[]): ProcedureOnBranch | undefined {
	let name: string | undefined;
	let spec: string | undefined;
	let state: ExecutionState | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom_message") continue;
		if (entry.customType === SKILL_PROMPT_MESSAGE_TYPE && entry.attribution === "user") {
			const details = entry.details as { name?: unknown } | undefined;
			if (typeof details?.name === "string" && details.name.length > 0) {
				// A later invocation restarts the procedure, so its head messages
				// must not be attributed to the earlier one.
				name = details.name;
				spec = undefined;
				state = undefined;
			}
		} else if (entry.customType === PROCEDURE_SPEC_MESSAGE_TYPE && name !== undefined) {
			spec = contentText(entry.content);
		} else if (entry.customType === STATE_MESSAGE_TYPE && name !== undefined) {
			const details = entry.details as { state?: unknown } | undefined;
			// Only entries this runtime wrote carry a plain-object details.state.
			if (isPlainObject(details?.state)) state = details.state as ExecutionState;
		}
	}
	if (name === undefined || spec === undefined || state === undefined) return undefined;
	return { name, spec, state };
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
