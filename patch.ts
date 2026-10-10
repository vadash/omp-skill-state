import type { ExecutionState } from "./state";

export const STATE_MESSAGE_TYPE = "sh.omp.skill-state.state";
export const RULES_MESSAGE_TYPE = "sh.omp.skill-state.rules";
export const PROCEDURE_SPEC_MESSAGE_TYPE = "sh.omp.skill-state.procedure-spec";
const PATCH_MARKER = "state";

// Runtime operating rules, model-facing: history is hidden, so the state is the
// only record of the past, and the fenced "state" block is the only write path.
export const OPERATING_RULES = `\
While a procedure runs, past conversation is hidden from you: the execution state is the only record of what happened.

To change the state, emit exactly one fenced block labelled \`state\` whose body is a single JSON object:

\`\`\`json state
{"key": "value", "obsolete": null}
\`\`\`

Merge semantics: a non-null value sets its key, null deletes its key, keys absent from the object are left untouched.

A reply with no state block is an empty patch and is fine.

An invalid block blocks every tool call of the step, and the error comes back as the tool result; fix the block and emit it again.
`;

export type ParsedPatch =
	| { kind: "none" }
	| { kind: "json"; value: unknown }
	| { kind: "error"; error: string };

// A plain ```json block without the marker is not a patch, so the stored-state block renderStateContent emits can never be parsed as one.
const FENCE_OPEN = new RegExp(`^[ \\t]*\`\`\`json[ \\t]+${PATCH_MARKER}[ \\t]*$`);
const FENCE_CLOSE = /^[ \t]*```[ \t]*$/;

// First closed "state" fence wins; schema validation stays in state.ts's applyPatch.
export function parsePatch(text: string): ParsedPatch {
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		if (!FENCE_OPEN.test(lines[i])) continue;
		const body: string[] = [];
		let closed = false;
		for (let j = i + 1; j < lines.length; j++) {
			if (FENCE_CLOSE.test(lines[j])) {
				closed = true;
				break;
			}
			body.push(lines[j]);
		}
		if (!closed) continue;
		try {
			return { kind: "json", value: JSON.parse(body.join("\n")) };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { kind: "error", error: `state patch is not valid JSON: ${reason}` };
		}
	}
	return { kind: "none" };
}

export function renderStateContent(state: ExecutionState): string {
	return `\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``;
}
