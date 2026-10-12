import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent";
import type { ExecutionState } from "./state";

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
