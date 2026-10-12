import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent";
import type { ExecutionState } from "./state";
import type { AgentMessage } from "./projection";

export const STATE_MESSAGE_TYPE = "sh.omp.skill-state.state";
export const RULES_MESSAGE_TYPE = "sh.omp.skill-state.rules";
export const PROCEDURE_SPEC_MESSAGE_TYPE = "sh.omp.skill-state.procedure-spec";

// Runtime operating rules, model-facing: history is hidden, so the state is the
// only record of the past, and the state_update tool is the only write path.
// Fence-free like every stored message: the harness's elide pass rewrites
// fenced blocks in place.
export const OPERATING_RULES = `\
While a procedure runs, past conversation is hidden from you: the execution state is the only record of what happened.

To change the state, call the state_update tool with a single patch object holding the change:

{"patch": {"key": "value", "obsolete": null}}

Merge semantics: a non-null value sets its key, null deletes its key, keys absent from the object are left untouched. Arrays are set whole, never merged: to add one item, send the complete array with the item added. Send only the keys that change.

A step with no state_update call is an empty patch and is fine.

Each reply is one step: the state_update call recording only what the last observation established, then the tool call that performs the next action. End a reply without tool calls only when the procedure is complete.

An invalid patch blocks every tool call of the step, and the error comes back as the tool result; fix the patch and call state_update again.
`;

// One rules message, the same object shape everywhere the rules are delivered:
// the first-step copy from before_agent_start and the stored head asides are
// built here so they are byte-equal by construction and the provider's cache
// prefix never sees a difference between them.
export function rulesMessage(): CustomMessagePayload {
	return { customType: RULES_MESSAGE_TYPE, content: OPERATING_RULES, display: false };
}

// The announcement line the harness prepends to the prompt of a user-invoked
// skill, and the extraction of every name announced in a prompt (a joined
// batch can carry several). Coupled to the harness template
// prompts/skills/user-invocation.md, first line, in the pinned
// @oh-my-pi/pi-coding-agent 18.8.7: if the template changes, detection
// silently degrades to the pre-#15 behavior (engage at message_end only, no
// first-step delivery).
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
// re-parsing the content.
export function stateMessage(state: ExecutionState): CustomMessagePayload {
	return { customType: STATE_MESSAGE_TYPE, content: renderStateContent(state), display: true, details: { state } };
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
