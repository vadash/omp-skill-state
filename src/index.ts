import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-coding-agent";
import { SKILL_PROMPT_MESSAGE_TYPE, contentText, scanBranch } from "./branch";
import { STATE_UPDATE_TOOL_NAME, STATE_UPDATE_DESCRIPTION, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE, announcedSkillNames, rulesMessage } from "./messages";
import { commitStep, compactionFor, headMessages, newProcedure, noteProjected, pendingNudges, recordReply, stateMessages } from "./procedure";
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

	// The state-write channel (ADR 0002): a strict, zero-approval tool built
	// and registered once at factory load, so the definition sits in every
	// session's tool declarations from turn 0 and its presence never depends
	// on engage ordering. Registration is permanent (no unregister exists), so
	// a call outside an active procedure meets the graceful error below.
	const z = pi.zod;
	const stateUpdate = {
		name: STATE_UPDATE_TOOL_NAME,
		label: "state update",
		// Top-level even under tools.xdev: a discoverable tool mounts as an
		// xd:// device, and the patch would then travel as freehand write
		// content — the malformed-input failure class this tool channel exists
		// to exclude (ADR 0002). "essential" keeps state_update a real tool
		// whose arguments are protocol-level JSON.
		loadMode: "essential" as const,
		description: STATE_UPDATE_DESCRIPTION,
		parameters: z.object({ patch: z.record(z.unknown()) }),
		strict: true,
		approval: { tier: "read", policy: "allow" } as const,
		async execute(_toolCallId: string, params: { patch: Record<string, unknown> }, _signal: AbortSignal | undefined, _onUpdate: undefined, ctx: ExtensionContext): Promise<AgentToolResult> {
			const procedure = current(ctx);
			// The definition stays registered after disengage (no unregister
			// exists), so a late call meets a graceful error, not a crash.
			if (procedure === undefined) return { content: [{ type: "text", text: "no active procedure" }], isError: true };
			// The fold validated this patch in assistant_message and blocked the
			// call when it was invalid; commitStep's repeat is defensive only.
			const step = commitStep(procedure, params.patch);
			if ("error" in step) return { content: [{ type: "text", text: step.error }], isError: true };
			// Aside delivery lands the state at the next step boundary, before
			// the next provider call, without interrupting the in-flight batch.
			// A commit stores both partitions, state core first.
			for (const payload of step.sends) pi.sendMessage(payload, { deliverAs: "aside" });
			return { content: [{ type: "text", text: step.result }] };
		},
	};
	pi.registerTool(stateUpdate);

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

	// The head: the operating rules, P, the state core and the scratch state,
	// one message each so the projection can take the last stored copy of
	// every type.
	function sendHead(procedure: Procedure, options: { deliverAs: "aside" | "nextTurn" }): void {
		for (const payload of headMessages(procedure)) pi.sendMessage(payload, options);
	}

	// Re-derives engagement from what is stored on the branch, so a cold load, a
	// /resume, a rewind or a tree navigation land on the procedure state that
	// branch actually carries. The head asides (rules, P, state core, scratch
	// state) are already on the branch and are never re-sent: the projection
	// takes the last of each type, and a fresh aside would shadow the real
	// stored state.
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

	// Renderer registration is a load-time call and needs no session state, so
	// it happens unconditionally at factory load, before any procedure engages.
	// Both stored state messages (state core, scratch state) render the same
	// way: collapsed names the keys, expanded shows the pretty JSON. The label
	// names the partition: with an empty state the two messages would otherwise
	// collapse to identical lines and read as a duplicated notice. theme is
	// structural because the harness's renderer type is not part of the root
	// export; the real Theme satisfies it.
	type StateTheme = { fg(role: string, text: string): string };
	function renderStateMessageFor(partition: string) {
		return function (message: { details?: { state?: ExecutionState } }, { expanded }: { expanded: boolean }, theme: StateTheme) {
			const state = message.details?.state;
			if (!isPlainObject(state)) return undefined;
			const keys = Object.keys(state);
			const list = keys.length > 6 ? `${keys.slice(0, 6).join(", ")} …` : keys.join(", ");
			const label = theme.fg("customMessageLabel", "skill-state");
			const lines = expanded
				? [`${label} ${partition}`, theme.fg("text", JSON.stringify(state, null, 2))]
				: [label + theme.fg("muted", ` ${partition} · ${keys.length} keys${keys.length > 0 ? `: ${list}` : ""}`)];
			return new Text(lines.join("\n"), 0, 0);
		};
	}
	pi.registerMessageRenderer<{ state?: ExecutionState }>(STATE_CORE_MESSAGE_TYPE, renderStateMessageFor("core"));
	pi.registerMessageRenderer<{ state?: ExecutionState }>(STATE_SCRATCH_MESSAGE_TYPE, renderStateMessageFor("scratch"));

	// The first step's rules ride in with the invocation batch itself. The hook
	// fires at the batch's dequeue, before the skill prompt's message_end can
	// engage, so engagement state cannot be consulted; detection comes from the
	// announcement line, which names the invoked skill, and the schema check
	// filters every non-procedure skill, so ordinary prompts match nothing.
	// Re-entry retries recompute the same answer from the same prompt, so the
	// stateless gate is re-entry-safe. The returned copy is byte-equal to the
	// head's rules, which the projection keeps taking from step 2 on, so the
	// provider's cache prefix is unchanged.
	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return undefined;
		for (const name of announcedSkillNames(event.prompt)) {
			if ((await loadStateSchema(name, pi.pi.getActiveSkills())).ok) {
				return { message: rulesMessage() };
			}
		}
		return undefined;
	});

	pi.on("assistant_message", (event, ctx) => {
		const procedure = current(ctx);
		if (procedure === undefined) return undefined;
		const content = event.message.content;
		// Every state_update call of the batch contributes its patch. All of
		// them are validated here, folded in declaration order before any tool
		// executes, so one invalid patch anywhere in the batch blocks the
		// whole step, every state_update call included.
		const patches: unknown[] = [];
		for (const block of content) {
			if (block.type === "toolCall" && block.name === STATE_UPDATE_TOOL_NAME) {
				patches.push((block.arguments as { patch?: unknown } | undefined)?.patch);
			}
		}
		const outcome = recordReply(procedure, { patches, hasPatch: patches.length > 0 });
		switch (outcome.kind) {
			case "ended":
				if (outcome.cause === "degrade") end(ctx, procedure, `degraded after ${procedure.params.retries} invalid patches; running ordinarily`, "warning");
				else end(ctx, procedure, `disengaged (idle for ${procedure.params.idleSteps} steps)`);
				break;
			default:
				// ok and none need nothing here: the state_update executes commit
				// their patches through commitStep after this handler; a blocked
				// step is refused at tool_call.
				break;
		}
		return undefined;
	});

	// The run's final state goes out once the session has settled, as a
	// next-turn message. agent_end fires inside the loop, where the harness only
	// holds a next-turn message in memory until the next prompt, and a /resume,
	// /new or quit before that prompt loses it. Once the session is idle the
	// harness appends it to context and history at once, so the send waits for
	// idle. The snapshot is the live state at agent_end; a patch accepted
	// meanwhile moves procedure.state, and the identity compare drops the stale copy.
	pi.on("agent_end", (_event, ctx) => {
		const procedure = current(ctx);
		if (procedure === undefined) return;
		const state = procedure.state;
		const sessionId = ctx.sessionManager.getSessionId();
		const settle = (attempts: number): void => {
			if (procedures.get(sessionId) !== procedure || procedure.state !== state) return;
			if (ctx.isIdle() || attempts === 0) {
				for (const payload of stateMessages(procedure)) pi.sendMessage(payload, { deliverAs: "nextTurn" });
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
		// The asides pin the stored head the projection takes from step 2 on;
		// the first step's rules already went out with the invocation batch,
		// through before_agent_start.
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
		const messages = project(event.messages, procedure.params.observationBytes, procedure.params.observationWindow);
		noteProjected(procedure, messages !== undefined);
		if (messages === undefined) return undefined;
		// Nudges ride on the per-call prompt only: never stored, never
		// re-sent from history. A step whose prompt carries no head returned
		// undefined above, so it neither counts nor warns.
		const nudges = pendingNudges(procedure);
		return nudges.length > 0 ? { messages: [...messages, ...nudges] } : { messages };
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
