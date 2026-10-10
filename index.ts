import { readFile } from "node:fs/promises";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ExtensionAPI, ExtensionContext, SessionBeforeSwitchEvent, Skill } from "@oh-my-pi/pi-coding-agent";

const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";

const SWITCH_TRIGGER: Record<SessionBeforeSwitchEvent["reason"], string> = {
	new: "/new",
	resume: "/resume",
	fork: "fork",
};

// Keyed by session id, not a bare flag: extension module state is shared across
// every session in one process, so one flag would leak a procedure between sessions.
export default function (pi: ExtensionAPI): void {
	const engaged = new Map<string, string>();

	function disengage(ctx: ExtensionContext, trigger: string): void {
		const sessionId = ctx.sessionManager.getSessionId();
		const name = engaged.get(sessionId);
		if (name === undefined) return;
		engaged.delete(sessionId);
		ctx.ui.notify(`skill-state: procedure "${name}" disengaged (${trigger})`, "info");
	}

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
		const isProcedure = await declaresStateSchema(name, pi.pi.getActiveSkills());
		// Re-check after the await: the agent dispatches events without awaiting
		// handlers, so a second invocation in the same batch can pass the check
		// above before this read resolves.
		if (!isProcedure || engaged.has(sessionId)) return;
		engaged.set(sessionId, name);
		ctx.ui.notify(`skill-state: procedure "${name}" engaged`, "info");
		ctx.ui.notify("skill-state: history is hidden from the model while engaged; finish with /new", "info");
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

// Isolated so issue #4 (state core) can replace it with the real schema loader.
// A procedure skill is one whose state.schema.json exists and parses to a plain
// object; anything else (missing file, unknown skill name, malformed JSON,
// array or null top level) is an ordinary skill and must stay silent.
async function declaresStateSchema(skillName: string, skills: readonly Skill[]): Promise<boolean> {
	try {
		const schemaPath = await InternalUrlRouter.instance().locate(`skill://${skillName}/state.schema.json`, { skills });
		if (schemaPath === null) return false;
		const parsed: unknown = JSON.parse(await readFile(schemaPath, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
	} catch {
		return false;
	}
}
