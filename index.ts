import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-coding-agent";
import { SKILL_PROMPT_MESSAGE_TYPE, contentText, scanBranch } from "./branch";
import { STATE_MESSAGE_TYPE } from "./patch";
import { compactionFor, headMessages, newProcedure, noteProjected, recordReply, stateMessage, takeFinalState } from "./procedure";
import type { Procedure } from "./procedure";
import { project } from "./projection";
import { isPlainObject, loadStateSchema } from "./state";
import type { ExecutionState, StateParams, StateSchema } from "./state";

// The final state waits for the session to go idle before it is stored; the
// harness settles within a few event-loop turns of agent_end, and a queued
// follow-up prompt keeps it busy, so after the attempts run out the message is
// sent anyway and the harness holds it for that prompt.
const FINAL_STATE_POLL_MS = 20;
const FINAL_STATE_POLL_ATTEMPTS = 100;

// The harness adapter. Every mechanism is a public extension event or action:
// each handler finds the session's procedure, hands the event to the step
// policy in procedure.ts, and turns the outcome into sends, blocks and notices.
// Procedures are keyed by session id, not held in a bare flag: extension module
// state is shared across every session in one process, so one flag would leak
// a procedure between sessions.
export default function (pi: ExtensionAPI): void {
	const procedures = new Map<string, Procedure>();
	let compactRegistered = false;

	// The engaged procedure of the main-agent session the event belongs to;
	// undefined when the session is inert or the event comes from a subagent.
	function current(ctx: ExtensionContext): Procedure | undefined {
		if (ctx.agent.kind !== "main") return undefined;
		return procedures.get(ctx.sessionManager.getSessionId());
	}

	// Every ending shares one reset: drop the record, then say why. The notice
	// is UI-only and never enters model context.
	function end(ctx: ExtensionContext, procedure: Procedure, notice: string, level: "info" | "warning" = "info"): void {
		procedures.delete(ctx.sessionManager.getSessionId());
		ctx.ui.notify(`skill-state: procedure "${procedure.name}" ${notice}`, level);
	}

	function disengage(ctx: ExtensionContext, trigger: string): void {
		const procedure = procedures.get(ctx.sessionManager.getSessionId());
		if (procedure === undefined) return;
		end(ctx, procedure, `disengaged (${trigger})`);
	}

	// Every procedure starts here with fresh counters, from a new invocation and
	// from a re-derive alike. Both notices are UI-only and never enter model context.
	function engage(ctx: ExtensionContext, sessionId: string, name: string, spec: string, loaded: { schema: StateSchema; params: StateParams }, state: ExecutionState): Procedure {
		// Registering a session_before_compact handler disables speculative
		// compaction for the session and pi.on has no counterpart, so the handler
		// can never be removed (ADR 0001): it is registered lazily, on the first
		// engage, so sessions that never run a procedure keep the harness default.
		if (!compactRegistered) {
			compactRegistered = true;
			pi.on("session_before_compact", (event, ctx) => {
				const procedure = current(ctx);
				if (procedure === undefined) return undefined;
				return compactionFor(procedure, event.preparation, event.branchEntries);
			});
		}
		const procedure = newProcedure(name, spec, loaded.schema, loaded.params, state);
		procedures.set(sessionId, procedure);
		ctx.ui.notify(`skill-state: procedure "${name}" engaged`, "info");
		ctx.ui.notify("skill-state: history is hidden from the model while engaged; finish with /new", "info");
		return procedure;
	}

	// The head: the operating rules, P and the current state, one message each
	// so the projection can take the last stored copy of every type.
	function sendHead(procedure: Procedure, options: { deliverAs: "aside" | "nextTurn" }): void {
		for (const payload of headMessages(procedure)) pi.sendMessage(payload, options);
	}

	// Re-derives engagement from what is stored on the branch, so a cold load, a
	// /resume, a rewind or a tree navigation land on the procedure state that
	// branch actually carries. The head asides (rules, P, state) are already on
	// the branch and are never re-sent: the projection takes the last of each
	// type, and a fresh aside would shadow the real stored state.
	async function rederive(ctx: ExtensionContext, trigger: string): Promise<void> {
		if (ctx.agent.kind !== "main") return;
		const found = scanBranch(ctx.sessionManager.getBranch());
		if (found !== undefined) {
			const loaded = await loadStateSchema(found.name, pi.pi.getActiveSkills());
			if (loaded.ok) {
				engage(ctx, ctx.sessionManager.getSessionId(), found.name, found.spec, loaded, found.state);
				return;
			}
		}
		disengage(ctx, trigger);
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
		const procedure = current(ctx);
		if (procedure === undefined) return undefined;
		const content = event.message.content;
		const outcome = recordReply(procedure, {
			text: content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
			hasToolCall: content.some((block) => block.type === "toolCall"),
		});
		switch (outcome.kind) {
			case "store":
				// Aside delivery lands the message at the next step boundary, so the
				// state is stored before the next provider call without interrupting
				// the in-flight tool batch. The final state instead waits for agent_end.
				if (outcome.delivery === "aside") pi.sendMessage(stateMessage(outcome.state), { deliverAs: "aside" });
				break;
			case "ended":
				if (outcome.cause === "degrade") end(ctx, procedure, `degraded after ${procedure.params.retries} invalid patches; running ordinarily`, "warning");
				else end(ctx, procedure, `disengaged (idle for ${procedure.params.idleSteps} steps)`);
				break;
			default:
				// none needs nothing; a blocked step is refused at tool_call.
				break;
		}
		return undefined;
	});

	// The final step's state goes out once the run has settled, as a next-turn
	// message. agent_end fires inside the loop, where the harness only holds a
	// next-turn message in memory until the next prompt, and a /resume, /new or
	// quit before that prompt loses it. Once the session is idle the harness
	// appends it to context and history at once, so the send waits for idle. A
	// patch accepted meanwhile makes this state stale, and it is dropped.
	pi.on("agent_end", (_event, ctx) => {
		const procedure = current(ctx);
		if (procedure === undefined) return;
		const state = takeFinalState(procedure);
		if (state === undefined) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const settle = (attempts: number): void => {
			if (procedures.get(sessionId) !== procedure || procedure.state !== state) return;
			if (ctx.isIdle() || attempts === 0) {
				pi.sendMessage(stateMessage(state), { deliverAs: "nextTurn" });
				return;
			}
			setTimeout(() => settle(attempts - 1), FINAL_STATE_POLL_MS);
		};
		settle(FINAL_STATE_POLL_ATTEMPTS);
	});

	pi.on("tool_call", (_event, ctx) => {
		const procedure = current(ctx);
		// pendingError is cleared only by the next reply, so every call of the
		// failed step is blocked, not just the first.
		if (procedure?.pendingError === undefined) return undefined;
		return { block: true, reason: procedure.pendingError };
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
		if (procedures.has(sessionId)) return;
		const loaded = await loadStateSchema(name, pi.pi.getActiveSkills());
		// Re-check after the await: the agent dispatches events without awaiting
		// handlers, so a second invocation in the same batch can pass the check
		// above before this read resolves.
		if (!loaded.ok || procedures.has(sessionId)) return;
		// P is the rendered skill prompt the harness already produced for this
		// invocation; it keeps the user's invocation args in every step and needs
		// no second file read.
		const procedure = engage(ctx, sessionId, name, contentText(message.content), loaded, {});
		// The projected prompt's head is pinned here at engage so it exists from
		// the first step.
		sendHead(procedure, { deliverAs: "aside" });
	});

	// A compaction cuts the context at the harness's kept entry, which can sit
	// after the head; the projection then finds no rules or P and falls back to
	// ordinary context. So the head is sent again after every compaction while
	// engaged: a copy lands after the cut, byte-equal to the originals, and the
	// projection takes the last of each type. It must reach the model without
	// starting a turn: during a run an aside lands at the next step boundary,
	// and when the session is idle, as with a manual /compact, a next-turn
	// message is appended to context without waking anything.
	pi.on("session_compact", (_event, ctx) => {
		const procedure = current(ctx);
		if (procedure === undefined) return;
		sendHead(procedure, ctx.isIdle() ? { deliverAs: "nextTurn" } : { deliverAs: "aside" });
	});

	// The projection rewrites only the prompt; the stored transcript stays
	// complete. undefined keeps the ordinary context: safe fallback when not
	// engaged, in a subagent, or when the head is not in place yet.
	pi.on("context", (event, ctx) => {
		const procedure = current(ctx);
		if (procedure === undefined) return undefined;
		const messages = project(event.messages, procedure.params.observationBytes);
		noteProjected(procedure, messages !== undefined);
		return messages === undefined ? undefined : { messages };
	});

	// A switch, rewind or fork lands in a different session id, so the outgoing
	// record is ended here (with the spec's disengage notice) and the incoming
	// session re-derives from the branch it loads; a fork re-derives like any
	// branch because the state it carries is current, not stale.
	const switchLabels: Record<"new" | "resume" | "fork", string> = { new: "/new", resume: "/resume", fork: "fork" };
	pi.on("session_before_switch", (event, ctx) => {
		disengage(ctx, switchLabels[event.reason]);
		return undefined;
	});

	pi.on("session_before_branch", (event, ctx) => {
		disengage(ctx, event.reason);
		return undefined;
	});

	pi.on("session_switch", async (_event, ctx) => {
		await rederive(ctx, "session switch");
	});

	pi.on("session_start", async (_event, ctx) => {
		await rederive(ctx, "session start");
	});

	// Both fire after the branch changed. A rewind lands in a new session id,
	// whose record was never engaged; tree navigation keeps the id, so there the
	// scan also disengages when the new leaf sits before the invocation.
	pi.on("session_branch", async (_event, ctx) => {
		await rederive(ctx, "branch");
	});

	pi.on("session_tree", async (_event, ctx) => {
		await rederive(ctx, "tree navigation");
	});

	pi.on("input", (event, ctx) => {
		// The input event fires before slash-command interpretation, so it is the
		// only surface that still sees the raw /clear text (/clear emits nothing
		// to extensions). Returning undefined keeps normal dispatch running.
		if (event.text.trim() === "/clear") disengage(ctx, "/clear");
		return undefined;
	});
}
