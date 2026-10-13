import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent";
import { isPlainObject } from "./types";
import type { ExecutionState } from "./state";
import type { AgentMessage, ProjectionFailure } from "./types";

export const STATE_CORE_MESSAGE_TYPE = "sh.omp.skill-state.core";
export const STATE_SCRATCH_MESSAGE_TYPE = "sh.omp.skill-state.scratch";
export const RULES_MESSAGE_TYPE = "sh.omp.skill-state.rules";
export const PROCEDURE_SPEC_MESSAGE_TYPE = "sh.omp.skill-state.procedure-spec";
// The harness's own message type for a skill invocation; a user-attributed
// one is what starts a procedure.
export const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";

// The patch channel's fixed name (ADR 0002), the one source for the
// registration in index.ts, the operating rules below and the adapter tests,
// so they cannot drift.
export const STATE_UPDATE_TOOL_NAME = "state_update";

// Runtime operating rules, model-facing: history is hidden, so the state is the
// only record of the past, and the state_update tool is the only write path.
// Fence-free like every stored message: the harness's elide pass rewrites
// fenced blocks in place. The tool name is interpolated so the rules can never
// drift from the registered definition.
export const OPERATING_RULES = `\
While a procedure runs, past conversation is hidden from you: the execution state is the only record of what happened.

To change the state, call the ${STATE_UPDATE_TOOL_NAME} tool directly with a single patch object holding the change:

{"patch": {"key": "value", "obsolete": null}}

Call it as a native tool call; do not redirect writes through xd:// devices or any other channel.

Merge semantics: a non-null value sets its key, null deletes its key, keys absent from the object are left untouched. Arrays accept the complete array (set whole) or an append operator that adds items without resending the rest:

{"patch": {"findings": {"$append": ["one new item"]}}}

Send only the keys that change.

A step with no ${STATE_UPDATE_TOOL_NAME} call is an empty patch and is fine.

Each reply is one step: the ${STATE_UPDATE_TOOL_NAME} call recording only what the last observation established, then the tool call that performs the next action. End a reply without tool calls only when the procedure is complete.

An invalid patch blocks every tool call of the step, and the error comes back as the tool result; fix the patch and call ${STATE_UPDATE_TOOL_NAME} again.
`;

export const STATE_UPDATE_DESCRIPTION =
	"Apply a patch to the running procedure's execution state. Call it once per step alongside your other tool calls. The patch is a JSON object merged into the state: a non-null value sets its key, null deletes its key, keys you omit are left untouched. Arrays accept the complete array or an {\"$append\": [items]} operator that adds items without resending the rest.";

// One rules message, the same object shape everywhere the rules are delivered:
// the first-step copy from before_agent_start and the stored head asides are
// built here so they are byte-equal by construction and the provider's cache
// prefix never sees a difference between them.
export function rulesMessage(): CustomMessagePayload {
	return { customType: RULES_MESSAGE_TYPE, content: OPERATING_RULES, display: false };
}

// The skill invocation, one spelling of what starts a procedure (CONTEXT.md
// "Skill invocation"): a user-attributed skill-prompt naming the invoked
// skill. Sync and pure — the state-schema check that decides "procedure
// skill" stays with the caller, through loadStateSchema. Shared by the
// adapter's message_end and the branch's re-derive scan.
export function skillInvocationName(msg: { customType?: string; attribution?: string; details?: unknown }): string | undefined {
	if (msg.customType !== SKILL_PROMPT_MESSAGE_TYPE || msg.attribution !== "user") return undefined;
	const name = (msg.details as { name?: unknown } | undefined)?.name;
	return typeof name === "string" && name.length > 0 ? name : undefined;
}

// The announcement line the harness prepends to the prompt of a user-invoked
// skill, and the extraction of every name announced in a prompt (a joined
// batch can carry several). Coupled to the pinned @oh-my-pi/pi-coding-agent
// 18.10.3 template src/prompts/skills/user-invocation.md, first line; the pin
// guard in messages.test.ts fails on a template change instead of letting
// detection degrade silently. Only the first-step delivery reads prose: at
// before_agent_start the invocation is not yet a stored message, so the
// structural predicate above cannot see it.
export function skillAnnouncement(name: string): string {
	return `[IMPORTANT: User invoked the "${name}" skill; follow its instructions. Full skill below.]`;
}

export function announcedSkillNames(prompt: string): string[] {
	return [...prompt.matchAll(/\[IMPORTANT: User invoked the "([^"]+)" skill;/g)].map((match) => match[1]);
}

// The stored state carries no fence and no XML: the harness's shake ("elide")
// pass rewrites any stored message in place when it holds a fenced or XML
// block of 400+ tokens, custom messages included, and a placeholder in its
// place would be sent to the model as its state. Plain JSON under a label is
// never a shake region. The state_update calling convention lives in the
// operating rules only.
export function renderStateContent(state: ExecutionState): string {
	return `Execution state (edit it with the state_update tool):\n${JSON.stringify(state, null, 2)}`;
}

// details.state lets later re-derives rebuild t from the branch without
// re-parsing the content. The execution state is stored as two messages (the
// state core and the scratch state, ADR 0003), each holding its partition.
export function coreMessage(core: ExecutionState): CustomMessagePayload {
	return { customType: STATE_CORE_MESSAGE_TYPE, content: renderStateContent(core), display: true, details: { state: core } };
}

export function scratchMessage(scratch: ExecutionState): CustomMessagePayload {
	return { customType: STATE_SCRATCH_MESSAGE_TYPE, content: renderStateContent(scratch), display: true, details: { state: scratch } };
}

// Domain predicates and the payload accessor for the stored state messages:
// one home for what a state message looks like, so the branch reads, the test
// session and any future consumer cannot drift apart on the shape.
export function isStateCoreMessage(entry: { customType?: string }): boolean {
	return entry.customType === STATE_CORE_MESSAGE_TYPE;
}

export function isStateScratchMessage(entry: { customType?: string }): boolean {
	return entry.customType === STATE_SCRATCH_MESSAGE_TYPE;
}

// The partition a state message carries, or undefined when the entry was not
// written by this runtime: only its own messages hold a plain-object
// details.state, and that check is the boundary.
export function extractStatePayload(details: unknown): ExecutionState | undefined {
	const state = isPlainObject(details) ? details.state : undefined;
	if (!isPlainObject(state)) return undefined;
	// This runtime only ever stores JSON values in details.state, so the
	// plain-object check above is the whole contract.
	const partition = state as ExecutionState;
	return partition;
}

// The idle warning the model sees one step before the cutoff. Per-call by
// construction: the context handler appends it to the projected prompt only,
// so it has no stored counterpart, never anchors the cache breakpoint and is
// never re-sent from history.
export function nudgeMessage(idle: number): AgentMessage {
	return {
		role: "developer",
		content: `The execution state has been unchanged for ${idle} consecutive steps. One more step without a state_update patch that changes the state disengages this procedure and returns the session to ordinary history-based execution. If there is anything worth keeping, record it in the state now with a state_update patch.`,
		timestamp: Date.now(),
	};
}

// The ask the model sees while the execution state is over its soft size cap.
// Per-call by construction, like the idle warning: appended to the projected
// prompt only, never stored, never re-sent from history.
export function consolidationNudgeMessage(): AgentMessage {
	return {
		role: "developer",
		content: `The execution state has grown past its size cap. Consolidate it with a state_update patch: drop superseded findings — delete keys that no longer matter (null deletes a key) and rewrite values to only what the rest of the run needs. The cap never blocks anything; it only asks for this cleanup.`,
		timestamp: Date.now(),
	};
}

// The notice the model sees when the projection could not be built and the
// step runs on ordinary context instead. Per-call by construction, like the
// nudges: appended to the prompt only, never stored, never re-sent from
// history. The step policy latches it, so one unprojected episode stays one
// notice no matter how many steps it spans.
export function fallbackNoticeMessage(reason: ProjectionFailure): AgentMessage {
	const why = reason === "incomplete-head"
		? "the stored head is incomplete"
		: "a tool result does not answer the tool call before it";
	return {
		role: "developer",
		content: `The state projection could not be built this step (${why}); the ordinary conversation is used instead. The projection resumes automatically once the head messages and tool pairing are back.`,
		timestamp: Date.now(),
	};
}
