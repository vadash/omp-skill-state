import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent";
import type { ExecutionState } from "./state";

export const STATE_MESSAGE_TYPE = "sh.omp.skill-state.state";
export const RULES_MESSAGE_TYPE = "sh.omp.skill-state.rules";
export const PROCEDURE_SPEC_MESSAGE_TYPE = "sh.omp.skill-state.procedure-spec";

// The stored state carries no fence and no XML: the harness's shake ("elide")
// pass rewrites any stored message in place when it holds a fenced or XML
// block of 400+ tokens, custom messages included, and a placeholder in t's
// place would be sent to the model as its state. Plain JSON under a label is
// never a shake region. The patch template lives in the operating rules only.
export function renderStateContent(state: ExecutionState): string {
	return `Execution state (edit it with the state block the rules describe):\n${JSON.stringify(state, null, 2)}`;
}

// details.state lets later re-derives rebuild t from the branch without
// re-parsing the content.
export function stateMessage(state: ExecutionState): CustomMessagePayload {
	return { customType: STATE_MESSAGE_TYPE, content: renderStateContent(state), display: true, details: { state } };
}
