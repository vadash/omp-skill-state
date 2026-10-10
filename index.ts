import type { ExtensionAPI, ExtensionContext, SessionBeforeSwitchEvent, Skill } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-coding-agent";
import { OPERATING_RULES, RULES_MESSAGE_TYPE, PROCEDURE_SPEC_MESSAGE_TYPE, STATE_MESSAGE_TYPE, parsePatch, renderStateContent } from "./patch";
import { project } from "./projection";
import { applyPatch, isPlainObject, loadStateSchema } from "./state";
import type { ExecutionState, StateParams, StateSchema } from "./state";

const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";

const SWITCH_TRIGGER: Record<SessionBeforeSwitchEvent["reason"], string> = {
	new: "/new",
	resume: "/resume",
	fork: "fork",
};

interface Engagement {
	name: string;
	schema: StateSchema;
	params: StateParams;
	state: ExecutionState;
	pendingError?: string;
	invalidPatches: number;
}

// Keyed by session id, not a bare flag: extension module state is shared across
// every session in one process, so one flag would leak a procedure between sessions.
export default function (pi: ExtensionAPI): void {
	const engaged = new Map<string, Engagement>();

	function disengage(ctx: ExtensionContext, trigger: string): void {
		const sessionId = ctx.sessionManager.getSessionId();
		const engagement = engaged.get(sessionId);
		if (engagement === undefined) return;
		engaged.delete(sessionId);
		ctx.ui.notify(`skill-state: procedure "${engagement.name}" disengaged (${trigger})`, "info");
	}

	// Degrade drops the engagement at once: the disengaging step is already
	// ordinary, and the pending error and invalid-patch counter die with the engagement.
	function recordInvalidPatch(engagement: Engagement, ctx: ExtensionContext, error: string): void {
		engagement.pendingError = error;
		engagement.invalidPatches += 1;
		if (engagement.invalidPatches < engagement.params.retries) return;
		engaged.delete(ctx.sessionManager.getSessionId());
		ctx.ui.notify(
			`skill-state: procedure "${engagement.name}" degraded after ${engagement.params.retries} invalid patches; running ordinarily`,
			"warning",
		);
	}

	// Renderer registration is a load-time call and needs no session state, so it
	// happens unconditionally at factory load, before any procedure engages.
	pi.registerMessageRenderer<{ state?: ExecutionState }>(STATE_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const state = message.details?.state;
		if (!isPlainObject(state)) return undefined;
		const keys = Object.keys(state);
		const list = keys.length > 6 ? `${keys.slice(0, 6).join(", ")} …` : keys.join(", ");
		const label = theme.fg("customMessageLabel", "skill-state");
		const lines = expanded
			? [label, theme.fg("text", JSON.stringify(state, null, 2))]
			: [label + theme.fg("muted", ` state · ${keys.length} keys${keys.length > 0 ? `: ${list}` : ""}`)];
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.on("assistant_message", (event, ctx) => {
		if (ctx.agent.kind !== "main") return undefined;
		const engagement = engaged.get(ctx.sessionManager.getSessionId());
		if (engagement === undefined) return undefined;
		const text = event.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		const patch = parsePatch(text);
		if (patch.kind === "none") {
			engagement.pendingError = undefined;
			engagement.invalidPatches = 0;
			return undefined;
		}
		if (patch.kind === "json") {
			const applied = applyPatch(engagement.state, patch.value, engagement.schema);
			if (applied.ok) {
				engagement.state = applied.state;
				engagement.pendingError = undefined;
				engagement.invalidPatches = 0;
				// Aside delivery lands the message at the next step boundary, so the
				// state is stored before the next provider call without interrupting
				// the in-flight tool batch. details.state lets later issues rebuild t
				// from the branch without re-parsing the content fence.
				pi.sendMessage(
					{
						customType: STATE_MESSAGE_TYPE,
						content: renderStateContent(engagement.state),
						display: true,
						details: { state: engagement.state },
					},
					{ deliverAs: "aside" },
				);
				return undefined;
			}
			recordInvalidPatch(engagement, ctx, applied.error);
			return undefined;
		}
		recordInvalidPatch(engagement, ctx, patch.error);
		return undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		if (ctx.agent.kind !== "main") return undefined;
		const engagement = engaged.get(ctx.sessionManager.getSessionId());
		if (engagement?.pendingError === undefined) return undefined;
		// pendingError is cleared only by the next assistant_message, so every call
		// of the failed step is blocked, not just the first.
		return { block: true, reason: engagement.pendingError };
	});

	pi.on("message_end", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const message = event.message;
		if (message.role !== "custom" || message.customType !== SKILL_PROMPT_MESSAGE_TYPE) return;
		if (message.attribution !== "user") return;
		const details = message.details as { name?: unknown } | undefined;
		const name = details?.name;
		if (typeof name !== "string" || name.length === 0) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (engaged.has(sessionId)) return;
		const loaded = await loadStateSchema(name, pi.pi.getActiveSkills());
		// Re-check after the await: the agent dispatches events without awaiting
		// handlers, so a second invocation in the same batch can pass the check
		// above before this read resolves.
		if (!loaded.ok || engaged.has(sessionId)) return;
		engaged.set(sessionId, { name, schema: loaded.schema, params: loaded.params, state: {}, invalidPatches: 0 });
		// The projected prompt's head is pinned here at engage: the operating rules,
		// the procedure spec P, and the initial state so the head exists from the
		// first step. P is the rendered skill prompt the harness already produced
		// for this invocation; it keeps the user's invocation args in every step
		// and needs no second file read.
		const procedureSpec = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
				: String(message.content);
		pi.sendMessage({ customType: RULES_MESSAGE_TYPE, content: OPERATING_RULES, display: false }, { deliverAs: "aside" });
		pi.sendMessage({ customType: PROCEDURE_SPEC_MESSAGE_TYPE, content: procedureSpec, display: false, details: { name } }, { deliverAs: "aside" });
		pi.sendMessage(
			{ customType: STATE_MESSAGE_TYPE, content: renderStateContent({}), display: true, details: { state: {} } },
			{ deliverAs: "aside" },
		);
		ctx.ui.notify(`skill-state: procedure "${name}" engaged`, "info");
		ctx.ui.notify("skill-state: history is hidden from the model while engaged; finish with /new", "info");
	});

	// The projection rewrites only the prompt; the stored transcript stays
	// complete. undefined keeps the ordinary context: safe fallback when not
	// engaged, in a subagent, or when the head is not in place yet.
	pi.on("context", (event, ctx) => {
		if (ctx.agent.kind !== "main") return undefined;
		const engagement = engaged.get(ctx.sessionManager.getSessionId());
		if (engagement === undefined) return undefined;
		const messages = project(event.messages, engagement.params.observationBytes);
		return messages === undefined ? undefined : { messages };
	});

	pi.on("session_before_switch", (event, ctx) => {
		disengage(ctx, SWITCH_TRIGGER[event.reason]);
	});

	pi.on("session_branch", (_event, ctx) => {
		disengage(ctx, "branch");
	});

	pi.on("session_tree", (_event, ctx) => {
		disengage(ctx, "tree navigation");
	});

	pi.on("input", (event, ctx) => {
		// The input event fires before slash-command interpretation, so it is the
		// only surface that still sees the raw /clear text (/clear emits nothing
		// to extensions). Returning undefined keeps normal dispatch running.
		if (event.text.trim() === "/clear") disengage(ctx, "/clear");
		return undefined;
	});
}

