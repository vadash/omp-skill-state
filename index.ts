import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-coding-agent";
import { OPERATING_RULES, RULES_MESSAGE_TYPE, PROCEDURE_SPEC_MESSAGE_TYPE, STATE_MESSAGE_TYPE, parsePatch, renderStateContent } from "./patch";
import { project } from "./projection";
import { applyPatch, isPlainObject, loadStateSchema } from "./state";
import type { ExecutionState, StateParams, StateSchema } from "./state";

const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";

// The final state waits for the session to go idle before it is stored; the
// harness settles within a few event-loop turns of agent_end, and a queued
// follow-up prompt keeps it busy, so after the attempts run out the message is
// sent anyway and the harness holds it for that prompt.
const FINAL_STATE_POLL_MS = 20;
const FINAL_STATE_POLL_ATTEMPTS = 100;

interface Engagement {
	name: string;
	// P, held so a re-head after compaction never depends on a branch scan.
	spec: string;
	schema: StateSchema;
	params: StateParams;
	state: ExecutionState;
	pendingError?: string;
	invalidPatches: number;
	idle: number;
	// Whether the latest provider call carried the head. The first step runs
	// before the engage asides land, and the step after a compaction can too;
	// the model has not seen the rules in such a step, so it cannot be idle.
	projected: boolean;
	// A state accepted from a message with no tool call: the run is ending, and
	// an aside that outlives a run wakes a turn of its own, so this one goes out
	// as a next-turn message once the session is idle after agent_end instead.
	finalState?: ExecutionState;
}

// Custom message content is a string or text blocks; the invocation's P is
// taken from and the stored P is read back through the same path.
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.flatMap((block) => (isPlainObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
			.join("\n");
	}
	return String(content);
}

// details.state lets later re-derives rebuild t from the branch without
// re-parsing the content.
function stateMessage(state: ExecutionState) {
	return { customType: STATE_MESSAGE_TYPE, content: renderStateContent(state), display: true, details: { state } };
}

// The compaction cut: the latest assistant message on the branch, i.e. the
// start of the current step, so the kept tail is exactly the step the next
// projection pins (its tool results follow it). The harness's own cut keeps a
// turn-sized tail the projection never sends but the harness still counts; a
// tail still over its recovery band makes it "rescue" the compaction with an
// elide pass that rewrites kept entries in place, the state messages included.
function currentStepCut(branch: SessionBeforeCompactEvent["branchEntries"]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "message" && entry.message?.role === "assistant") return entry.id;
	}
	return undefined;
}

// Keyed by session id, not a bare flag: extension module state is shared across
// every session in one process, so one flag would leak a procedure between sessions.
export default function (pi: ExtensionAPI): void {
	const engaged = new Map<string, Engagement>();
	let compactRegistered = false;

	function disengage(ctx: ExtensionContext, trigger: string): void {
		const sessionId = ctx.sessionManager.getSessionId();
		const engagement = engaged.get(sessionId);
		if (engagement === undefined) return;
		engaged.delete(sessionId);
		ctx.ui.notify(`skill-state: procedure "${engagement.name}" disengaged (${trigger})`, "info");
	}

	// Degrade drops the engagement at once: the disengaging step is already
	// ordinary, and the pending error and invalid-patch counter die with the engagement.
	// A patch of any kind counts as activity, so it also breaks an idle run.
	function recordInvalidPatch(engagement: Engagement, ctx: ExtensionContext, error: string): void {
		engagement.pendingError = error;
		engagement.invalidPatches += 1;
		engagement.idle = 0;
		if (engagement.invalidPatches < engagement.params.retries) return;
		engaged.delete(ctx.sessionManager.getSessionId());
		ctx.ui.notify(
			`skill-state: procedure "${engagement.name}" degraded after ${engagement.params.retries} invalid patches; running ordinarily`,
			"warning",
		);
	}

	// A step the model spent without editing its state. A step whose prompt
	// carried no head does not count: the model never saw the rules in it.
	function recordIdle(engagement: Engagement, ctx: ExtensionContext): void {
		if (!engagement.projected) return;
		engagement.idle += 1;
		if (engagement.idle >= engagement.params.idleSteps) disengage(ctx, `idle for ${engagement.params.idleSteps} steps`);
	}

	// Every engagement starts here with fresh counters, from a new invocation and
	// from a re-derive alike. Both notices are UI-only and never enter model context.
	function engage(ctx: ExtensionContext, sessionId: string, name: string, spec: string, loaded: { schema: StateSchema; params: StateParams }, state: ExecutionState): Engagement {
		// Registering a session_before_compact handler disables speculative
		// compaction for the session and pi.on has no counterpart, so the handler
		// can never be removed (ADR 0001): it is registered lazily, on the first
		// engage, so sessions that never run a procedure keep the harness default.
		if (!compactRegistered) {
			compactRegistered = true;
			pi.on("session_before_compact", (event, ctx) => {
				if (ctx.agent.kind !== "main") return undefined;
				const engagement = engaged.get(ctx.sessionManager.getSessionId());
				if (engagement === undefined) return undefined;
				return {
					compaction: {
						summary: `Execution state of procedure "${engagement.name}" (skill-state runtime):\n\n${JSON.stringify(engagement.state, null, 2)}`,
						shortSummary: `skill-state: procedure "${engagement.name}" execution state`,
						firstKeptEntryId: currentStepCut(event.branchEntries) ?? event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						preserveData: { state: engagement.state },
					},
				};
			});
		}
		const engagement: Engagement = { name, spec, schema: loaded.schema, params: loaded.params, state, invalidPatches: 0, idle: 0, projected: false };
		engaged.set(sessionId, engagement);
		ctx.ui.notify(`skill-state: procedure "${name}" engaged`, "info");
		ctx.ui.notify("skill-state: history is hidden from the model while engaged; finish with /new", "info");
		return engagement;
	}

	// The head: the operating rules, P and the current state, one message each
	// so the projection can take the last stored copy of every type.
	function sendHead(engagement: Engagement, options: { deliverAs: "aside" | "nextTurn" }): void {
		pi.sendMessage({ customType: RULES_MESSAGE_TYPE, content: OPERATING_RULES, display: false }, options);
		pi.sendMessage({ customType: PROCEDURE_SPEC_MESSAGE_TYPE, content: engagement.spec, display: false, details: { name: engagement.name } }, options);
		pi.sendMessage(stateMessage(engagement.state), options);
	}

	// Re-derives engagement from what is stored on the branch, so a cold load, a
	// /resume, a rewind or a tree navigation land on the procedure state that
	// branch actually carries. The head asides (rules, P, state) are already on
	// the branch and are never re-sent: the projection takes the last of each
	// type, and a fresh aside would shadow the real stored state.
	async function rederive(ctx: ExtensionContext, trigger: string): Promise<void> {
		if (ctx.agent.kind !== "main") return;
		let name: string | undefined;
		let spec: string | undefined;
		let state: ExecutionState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom_message") continue;
			if (entry.customType === SKILL_PROMPT_MESSAGE_TYPE && entry.attribution === "user") {
				const details = entry.details as { name?: unknown } | undefined;
				if (typeof details?.name === "string" && details.name.length > 0) {
					// A later invocation restarts the procedure, so its head messages
					// must not be attributed to the earlier one.
					name = details.name;
					spec = undefined;
					state = undefined;
				}
			} else if (entry.customType === PROCEDURE_SPEC_MESSAGE_TYPE && name !== undefined) {
				spec = contentText(entry.content);
			} else if (entry.customType === STATE_MESSAGE_TYPE && name !== undefined) {
				const details = entry.details as { state?: unknown } | undefined;
				// Only entries this runtime wrote carry a plain-object details.state.
				if (isPlainObject(details?.state)) state = details.state as ExecutionState;
			}
		}
		if (name !== undefined && spec !== undefined && state !== undefined) {
			const loaded = await loadStateSchema(name, pi.pi.getActiveSkills());
			if (loaded.ok) {
				engage(ctx, ctx.sessionManager.getSessionId(), name, spec, loaded, state);
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
		if (ctx.agent.kind !== "main") return undefined;
		const engagement = engaged.get(ctx.sessionManager.getSessionId());
		if (engagement === undefined) return undefined;
		const text = event.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		const patch = parsePatch(text);
		if (patch.kind === "none") {
			engagement.pendingError = undefined;
			engagement.invalidPatches = 0;
			recordIdle(engagement, ctx);
			return undefined;
		}
		if (patch.kind === "json") {
			const applied = applyPatch(engagement.state, patch.value, engagement.schema);
			if (applied.ok) {
				engagement.pendingError = undefined;
				engagement.invalidPatches = 0;
				// A patch that leaves the state as it was is an empty patch: there is
				// nothing to store, and the model did not edit its state this step.
				if (renderStateContent(applied.state) === renderStateContent(engagement.state)) {
					recordIdle(engagement, ctx);
					return undefined;
				}
				engagement.state = applied.state;
				engagement.idle = 0;
				if (event.message.content.some((block) => block.type === "toolCall")) {
					// Aside delivery lands the message at the next step boundary, so the
					// state is stored before the next provider call without interrupting
					// the in-flight tool batch.
					pi.sendMessage(stateMessage(engagement.state), { deliverAs: "aside" });
				} else {
					engagement.finalState = engagement.state;
				}
				return undefined;
			}
			recordInvalidPatch(engagement, ctx, applied.error);
			return undefined;
		}
		recordInvalidPatch(engagement, ctx, patch.error);
		return undefined;
	});

	// The final step's state goes out once the run has settled, as a next-turn
	// message. agent_end fires inside the loop, where the harness only holds a
	// next-turn message in memory until the next prompt, and a /resume, /new or
	// quit before that prompt loses it. Once the session is idle the harness
	// appends it to context and history at once, so the send waits for idle. A
	// patch accepted meanwhile makes this state stale, and it is dropped.
	pi.on("agent_end", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const sessionId = ctx.sessionManager.getSessionId();
		const engagement = engaged.get(sessionId);
		if (engagement?.finalState === undefined) return;
		const state = engagement.finalState;
		engagement.finalState = undefined;
		const settle = (attempts: number): void => {
			if (engaged.get(sessionId) !== engagement || engagement.state !== state) return;
			if (ctx.isIdle() || attempts === 0) {
				pi.sendMessage(stateMessage(state), { deliverAs: "nextTurn" });
				return;
			}
			setTimeout(() => settle(attempts - 1), FINAL_STATE_POLL_MS);
		};
		settle(FINAL_STATE_POLL_ATTEMPTS);
	});

	pi.on("tool_call", (_event, ctx) => {
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
		// P is the rendered skill prompt the harness already produced for this
		// invocation; it keeps the user's invocation args in every step and needs
		// no second file read.
		const engagement = engage(ctx, sessionId, name, contentText(message.content), loaded, {});
		// The projected prompt's head is pinned here at engage so it exists from
		// the first step.
		sendHead(engagement, { deliverAs: "aside" });
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
		if (ctx.agent.kind !== "main") return;
		const engagement = engaged.get(ctx.sessionManager.getSessionId());
		if (engagement === undefined) return;
		sendHead(engagement, ctx.isIdle() ? { deliverAs: "nextTurn" } : { deliverAs: "aside" });
	});

	// The projection rewrites only the prompt; the stored transcript stays
	// complete. undefined keeps the ordinary context: safe fallback when not
	// engaged, in a subagent, or when the head is not in place yet.
	pi.on("context", (event, ctx) => {
		if (ctx.agent.kind !== "main") return undefined;
		const engagement = engaged.get(ctx.sessionManager.getSessionId());
		if (engagement === undefined) return undefined;
		const messages = project(event.messages, engagement.params.observationBytes);
		engagement.projected = messages !== undefined;
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
