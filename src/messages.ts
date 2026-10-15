import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent";
import { isPlainObject } from "./types";
import type { ExecutionState } from "./state";
import type { AgentMessage } from "./types";

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

// The legacy single state message an older runtime version stored: never a
// head message and never tail-eligible, wherever it sits on the branch.
export const LEGACY_STATE_MESSAGE_TYPE = "sh.omp.skill-state.state";

// The live-state blocks other harness features inject around the model. They
// are runtime machinery, not conversation, so the tail drops them everywhere;
// every other stored message is tail-eligible.
export const LIVE_STATE_CUSTOM_TYPES = [
	"goal-mode-context",
	"plan-mode-context",
	"plan-mode-reference",
	"eager-todo-prelude",
	"eager-task-prelude",
	"mid-run-todo-nudge",
	"ttsr-injection",
	"todo-error-reminder",
	"experimental-context-notes-reminder",
] as const;

// Runtime operating rules, model-facing: older conversation leaves the prompt
// as the tail evicts it, so the execution state is the durable record of the
// past, and the state_update tool is the only write path. Fence-free like
// every stored message: the harness's elide pass rewrites fenced blocks in
// place. The tool name is interpolated so the rules can never drift from the
// registered definition.
export const OPERATING_RULES = `\
While a procedure runs, older conversation leaves your prompt: the execution state is the durable record of what happened, and only the most recent messages stay visible.

To change the state, call the ${STATE_UPDATE_TOOL_NAME} tool directly with a single patch object holding the change:

{"patch": {"key": "value", "obsolete": null}}

Call it as a native tool call; do not redirect writes through xd:// devices or any other channel.

Merge semantics: a non-null value sets its key, null deletes its key, keys absent from the object are left untouched. Arrays accept the complete array (set whole) or the root operators, which edit items without resending the rest:

{"patch": {"plan": ["step 1", "step 2"]}}
{"patch": {"$append": {"findings": ["one new item"]}, "next_step": "Write HTML report"}}
{"patch": {"$remove": {"findings": ["the item to retire"]}}}

$append and $remove are root keys of the patch, each mapping state keys to item arrays. To replace an array entirely, assign it directly: {"plan": [...]}. One patch cannot both set and operate on a key, or both append and remove one key; any other $-prefixed root key is rejected as an unknown operator.

Send only the keys that change.

A step with no ${STATE_UPDATE_TOOL_NAME} call is an empty patch and is fine.

Each reply is one step: the ${STATE_UPDATE_TOOL_NAME} call recording only what the last observation established, then the tool call that performs the next action. End a reply without tool calls only when the procedure is complete.

An invalid patch blocks every tool call of the step, and the error comes back as the tool result; fix the patch and call ${STATE_UPDATE_TOOL_NAME} again.
`;

export const STATE_UPDATE_DESCRIPTION =
	"Apply a patch to the running procedure's execution state. Call it once per step alongside your other tool calls. The patch is a JSON object merged into the state: a non-null value sets its key, null deletes its key, keys you omit are left untouched. The root operators {\"$append\": {\"key\": [items]}} and {\"$remove\": {\"key\": [items]}} edit array items without resending the rest; one patch cannot both set and operate on a key, or both append and remove one key.";

// One rules message, the same object shape everywhere the rules are delivered:
// the first-step copy from before_agent_start and the stored head asides are
// built here so they are byte-equal by construction and the provider's cache
// prefix never sees a difference between them.
export function rulesMessage(): CustomMessagePayload {
	return { customType: RULES_MESSAGE_TYPE, content: operatingRules(), display: false };
}

// The tail awareness appended to the shared rules body: what the prompt
// carries, the pair-tag convention and the state-hygiene line, in that order.
export function operatingRules(): string {
	return `${OPERATING_RULES}\
Your prompt carries the tail: the most recent stored messages behind the state core, oldest first; older messages leave the prompt when it outgrows its budget.
Each tailed tool result carries a pair tag like [#a3f2 read]; the notice after the tail lists the tags oldest first — the first tags evict soonest.
The state is a working record, not a log: keep entries short, drop what later facts supersede, null deletes a key you no longer need.
`;
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

// The idle ask the model sees after idleSteps consecutive steps without a
// state change, once per quiet episode. Per-call by construction: the context
// handler appends it to the projected prompt only, so it has no stored
// counterpart, never anchors the cache breakpoint and is never re-sent from
// history. A reminder, never a deadline: it names no consequence.
export function idleNudgeMessage(idle: number): AgentMessage {
	return {
		role: "developer",
		content: `The execution state has been unchanged for ${idle} consecutive steps. If there is anything worth keeping, record a meaningful fact in the state now with a state_update patch. This is a reminder, not a deadline.`,
		timestamp: Date.now(),
	};
}

// The ask the model sees while the execution state is over its soft size cap.
// Per-call by construction, like the idle ask: appended to the projected
// prompt only, never stored, never re-sent from history.
export function consolidationNudgeMessage(): AgentMessage {
	return {
		role: "developer",
		content: `The execution state has grown past its size cap. Consolidate it with a state_update patch: drop superseded findings — delete keys that no longer matter (null deletes a key) and rewrite values to only what the rest of the run needs. The cap never blocks anything; it only asks for this cleanup.`,
		timestamp: Date.now(),
	};
}

// The window notice (CONTEXT.md): one per-call developer line after the tail,
// listing the tailed tool results' tags and tools oldest first with the drop
// rule. Data only: it never predicts which result evicts, because the chunked
// eviction keeps the front still between evictions. The step policy appends
// it before the nudges, so the data about the tail precedes the policy asks
// built on it.
export function windowNoticeMessage(window: readonly { tag: string; toolName: string }[]): AgentMessage {
	const list = window.map((pair) => `#${pair.tag} ${pair.toolName}`).join(", ");
	return {
		role: "developer",
		content: `tail oldest→newest: ${list} — oldest evict first when the prompt outgrows its budget`,
		timestamp: Date.now(),
	};
}

// The notice the model sees when the projection could not be built and the
// step runs on ordinary context instead. Per-call by construction, like the
// nudges: appended to the prompt only, never stored, never re-sent from
// history. The step policy latches it, so one unprojected episode stays one
// notice no matter how many steps it spans. The only failure reason is an
// incomplete head: an empty tail degrades in place instead (ADR 0005).
export function fallbackNoticeMessage(): AgentMessage {
	return {
		role: "developer",
		content: `The state projection could not be built this step (the stored head is incomplete); the ordinary conversation is used instead. The projection resumes automatically once the head messages are back.`,
		timestamp: Date.now(),
	};
}

// The notice a degraded step carries (ADR 0005, narrowed by ADR 0010): the
// head is intact but nothing is stored behind it, so the step's prompt has no
// recent transcript in it. Per-call by construction, like the nudges:
// appended to the prompt only, never stored, never re-sent from history. It
// rides every degraded step with no latch, because a degraded model sees only
// the head and cannot know why the tail is empty. The wording keeps this
// projection gap apart from the procedure's retries-exhausted degrade, a
// different failure.
export function degradationNoticeMessage(): AgentMessage {
	return {
		role: "developer",
		content: `No recent transcript is in the prompt this step: it carries the procedure head only (operating rules, skill, execution state). The execution state is intact and current; nothing was lost. Continue from the state.`,
		timestamp: Date.now(),
	};
}
