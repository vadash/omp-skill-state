import type { ExtensionAPI, ExtensionContext, SessionEntry, Skill, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { zod } from "@oh-my-pi/pi-coding-agent";
import { statePairs } from "../src/branch";
import extension from "../src/index";
import { SKILL_PROMPT_MESSAGE_TYPE, skillAnnouncement } from "../src/messages";
import type { ExecutionState } from "../src/state";
import { ZERO_USAGE } from "./entries";

// A fake omp session for the adapter tests: one factory (one handler map) with
// N sessions keyed by id. Each session owns its branch, sends, notices, idle
// flag and blocked calls, and auto-dispatches the harness's event order inside
// one verb. The fidelity model, small enough to audit against
// docs/extensions.md:
//
// - step() dispatches context, then assistant_message, then tool_call per
//   call, then stores the reply and its results on the branch, then flushes
//   pending messages.
// - invoke() and prompt() dispatch before_agent_start first (the batch's
//   dequeue precedes the input append), then persist the batch input; any
//   message a before_agent_start handler returns is recorded on `injected`
//   and stored on the branch in batch order, before the boundary-flushed
//   asides.
// - A message sent while busy flushes at the end of the current step, so the
//   first step after engage carries no head: the engage asides land at the
//   first step boundary (spec section 11.4), and the step after a compaction
//   can run before the re-sent head lands.
// - A message sent while idle is appended to the branch at once: "aside" would
//   start a turn in the real harness and "nextTurn" is appended without one,
//   which is what the settle poll and the idle compaction rely on.
// - A reply with no tool call ends the run: agent_end fires.
// - A tool call whose name has a captured registerTool definition runs that
//   definition's execute inside the step, and the recorded result is its own
//   (content and isError); calls without a captured definition get a fake "ok".
// - A blocked tool call is recorded and produces no result, as the harness
//   emits no result hook for a call that never ran.
// - compact() makes no summarizer call and stores no summary entry; when the
//   handler returns undefined the branch is left alone (the harness's own
//   default compaction is not modelled).

type Handler = (event: unknown, ctx: unknown) => unknown;

export interface Sent {
	payload: Record<string, unknown>;
	options: Record<string, unknown>;
}

export interface BlockedCall {
	toolName: string;
	toolCallId: string;
	reason: string;
}

export interface CompactionOutput {
	compaction?: { summary: string; shortSummary?: string; firstKeptEntryId: string; tokensBefore: number; preserveData?: unknown };
}

interface Internals {
	handlers: Map<string, Handler>;
	renderers: Map<string, unknown>;
	// The definitions registerTool captured, keyed by name.
	tools: Map<string, ToolDefinition>;
	// The session whose event is dispatching; sendMessage has no session of its
	// own, so the fake attributes sends to it.
	current?: FakeSession;
	// The most recent dispatcher: a send from a timer (the settle poll) fires
	// after the dispatch returned and belongs to the session that scheduled it.
	last?: FakeSession;
}

export interface FakeOmp {
	session(id: string, opts?: { kind?: "main" | "sub"; branch?: SessionEntry[] }): FakeSession;
	renderers: Map<string, unknown>;
	registered(event: string): boolean;
	// The definition registerTool captured for a tool name, undefined before
	// the first engage captured one.
	tool(name: string): ToolDefinition | undefined;
}

export function fakeOmp(skills: Skill[]): FakeOmp {
	const internals: Internals = { handlers: new Map(), renderers: new Map(), tools: new Map() };
	const pi = {
		on(event: string, handler: Handler) {
			internals.handlers.set(event, handler);
		},
		sendMessage(payload: Record<string, unknown>, options: Record<string, unknown> = {}) {
			(internals.current ?? internals.last)?.recordSend(payload, options);
		},
		registerMessageRenderer(type: string, renderer: unknown) {
			internals.renderers.set(type, renderer);
		},
		registerTool(definition: ToolDefinition) {
			internals.tools.set(definition.name, definition);
		},
		// The injected schema builder, as the real harness provides it: the
		// factory builds state_update's parameters with it at load.
		zod,
		pi: { getActiveSkills: () => skills },
	} as unknown as ExtensionAPI;
	extension(pi);
	const sessions = new Map<string, FakeSession>();
	return {
		renderers: internals.renderers,
		registered: (event: string) => internals.handlers.has(event),
		tool: (name: string) => internals.tools.get(name),
		session(id, opts = {}) {
			let session = sessions.get(id);
			if (session === undefined) {
				session = new FakeSession(internals, id, opts.kind ?? "main", opts.branch ?? []);
				sessions.set(id, session);
			}
			return session;
		},
	};
}

export class FakeSession {
	readonly id: string;
	readonly kind: "main" | "sub";
	// The stored entries from the session root to the current leaf.
	branch: SessionEntry[];
	// Every sendMessage as the factory made it, in order.
	sends: Sent[] = [];
	// Every payload a before_agent_start handler returned for this session, in
	// order: the rules copy that reaches the model on the invocation batch.
	injected: Record<string, unknown>[] = [];
	notices: Array<{ message: string; type?: string }> = [];
	blocked: BlockedCall[] = [];
	// The projection result of each provider call, in order; undefined when the
	// call ran on ordinary context.
	prompts: Array<unknown[] | undefined> = [];
	// The message list the last context event received, as the fake built it.
	lastContextMessages: unknown[] | undefined;
	lastCompaction: CompactionOutput | undefined;
	idle = false;
	// The context-usage read the context handler consults for the window size.
	// The default is the common large-context tier; a test overrides it to
	// watch the tail budget move.
	contextUsage: { tokens: number; contextWindow: number; percent: number } | undefined = { tokens: 0, contextWindow: 262_144, percent: 0 };
	private readonly internals: Internals;
	// Sends that land at the next step boundary (busy) rather than at once (idle).
	private pending: Sent[] = [];
	private seq = 0;

	constructor(internals: Internals, id: string, kind: "main" | "sub", branch: SessionEntry[]) {
		this.internals = internals;
		this.id = id;
		this.kind = kind;
		this.branch = branch;
	}

	// The merged execution state of every stored state pair (CONTEXT.md
	// "State pair"), in order — read through the runtime's own pairing read,
	// so the fake's view cannot drift from re-derive.
	get storedStates(): ExecutionState[] {
		return statePairs(this.branch).map(({ core, scratch }) => ({ ...core, ...scratch }));
	}

	setIdle(value: boolean): void {
		this.idle = value;
	}

	// A user or agent skill invocation: the harness dequeues the batch
	// (before_agent_start first, with the announcement only on a user
	// attribution), stores the skill-prompt message and fires message_end; a
	// schema-bearing skill engages. Input messages persist in batch order, so
	// any returned payload lands on the branch at once, before the
	// boundary-flushed asides.
	async invoke(name: string, opts: { attribution?: "user" | "agent"; details?: unknown } = {}): Promise<void> {
		const content = `Running skill ${name}`;
		const details = opts.details ?? { name };
		const attribution = opts.attribution ?? "user";
		// The real user-invocation template announces the skill; the autoload
		// and agent template has no announcement.
		const injected = await this.startBatch(attribution === "user" ? `${skillAnnouncement(name)}\n\n${content}` : content);
		const message = { role: "custom", customType: SKILL_PROMPT_MESSAGE_TYPE, content, display: true, timestamp: Date.now(), details, attribution };
		this.branch.push({
			type: "custom_message",
			id: this.nextId(),
			parentId: null,
			timestamp: new Date(0).toISOString(),
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content,
			display: true,
			details,
			attribution,
		} as SessionEntry);
		await this.dispatch("message_end", { type: "message_end", message });
		if (injected !== undefined) this.recordInjection(injected);
	}

	// A plain user batch: no skill announcement, just the prompt text.
	async prompt(text: string): Promise<Record<string, unknown> | undefined> {
		const injected = await this.startBatch(text);
		if (injected !== undefined) this.recordInjection(injected);
		return injected;
	}

	// A message_end for anything else: a model skill read, a foreign message.
	async endMessage(message: Record<string, unknown>): Promise<void> {
		await this.dispatch("message_end", { type: "message_end", message });
	}

	// One step: context, reply, tool calls, storage, flush. A reply with no
	// tool call ends the run. Returns the projection result of the context call.
	async step(text: string, opts: { tools?: string[]; results?: string[]; arguments?: unknown[] } = {}): Promise<unknown[] | undefined> {
		const tools = opts.tools ?? ["read"];
		const prompt = await this.context();
		const calls = tools.map((name, i) => ({ name, id: `call-${++this.seq}`, args: opts.arguments?.[i] ?? {} }));
		const message: Record<string, unknown> = {
			role: "assistant",
			content: [{ type: "text", text }, ...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.args }))],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: ZERO_USAGE,
			stopReason: calls.length > 0 ? "toolUse" : "stop",
			timestamp: Date.now(),
		};
		await this.dispatch("assistant_message", { type: "assistant_message", message });
		const stored = [this.messageEntry(message)];
		for (const [i, call] of calls.entries()) {
			const out = (await this.dispatch("tool_call", { type: "tool_call", toolName: call.name, toolCallId: call.id, input: { path: "x" } })) as
				| { block?: boolean; reason?: string }
				| undefined;
			if (out?.block === true) {
				this.blocked.push({ toolName: call.name, toolCallId: call.id, reason: out.reason ?? "" });
				continue;
			}
			// A captured definition runs for real, right after the tool_call
			// dispatch, and its own result is what the branch records.
			const definition = this.internals.tools.get(call.name);
			const result = definition === undefined ? undefined : await definition.execute(call.id, call.args, undefined, undefined, this.ctx());
			stored.push(
				this.messageEntry({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: result?.content ?? [{ type: "text", text: opts.results?.[i] ?? "ok" }],
					isError: result?.isError ?? false,
					timestamp: Date.now(),
				}),
			);
		}
		this.branch.push(...stored);
		this.flush();
		if (calls.length === 0) await this.dispatch("agent_end", { type: "agent_end", messages: [] });
		return prompt;
	}

	// A user prompt arriving mid-run: the input lands on the branch the way
	// the harness appends it before the provider call, then a context call
	// whose message list ends in the user turn. No reply follows; the test
	// asserts what the model would see.
	async userTurn(text: string): Promise<unknown[] | undefined> {
		this.branch.push({
			type: "message",
			id: this.nextId(),
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: text, timestamp: Date.now() },
		} as SessionEntry);
		return await this.context();
	}

	// One compaction: the harness fires session_before_compact, applies the
	// returned cut to the branch, then fires session_compact. No summarizer.
	async compact(preparation: { firstKeptEntryId?: string; tokensBefore?: number; previousPreserveData?: unknown } = {}): Promise<CompactionOutput | undefined> {
		const prep = { firstKeptEntryId: preparation.firstKeptEntryId ?? this.branch.at(-1)?.id ?? "e0", tokensBefore: preparation.tokensBefore ?? 0, ...(preparation.previousPreserveData === undefined ? {} : { previousPreserveData: preparation.previousPreserveData }) };
		const out = (await this.dispatch("session_before_compact", {
			type: "session_before_compact",
			preparation: prep,
			signal: new AbortController().signal,
			branchEntries: [...this.branch],
		})) as CompactionOutput | undefined;
		this.lastCompaction = out;
		const cut = out?.compaction?.firstKeptEntryId;
		if (cut !== undefined) {
			const at = this.branch.findIndex((entry) => entry.id === cut);
			if (at > 0) this.branch = this.branch.slice(at);
		}
		await this.dispatch("session_compact", { type: "session_compact", compactionEntry: {}, fromExtension: out?.compaction !== undefined });
		return this.lastCompaction;
	}

	// A switch, rewind or fork: the outgoing session ends, the incoming one
	// re-derives from the branch it carries.
	async switchTo(target: FakeSession, reason: "new" | "resume" | "fork" = "new"): Promise<void> {
		await this.dispatch("session_before_switch", { type: "session_before_switch", reason, targetSessionFile: `${target.id}.jsonl` });
		await target.dispatch("session_switch", { type: "session_switch", reason, previousSessionFile: `${this.id}.jsonl` });
	}

	async rewindTo(target: FakeSession): Promise<void> {
		await this.dispatch("session_before_branch", { type: "session_before_branch", reason: "branch", entryId: "e1" });
		await target.dispatch("session_branch", { type: "session_branch", reason: "branch", previousSessionFile: `${this.id}.jsonl` });
	}

	async tree(leafId: string | null = null): Promise<void> {
		await this.dispatch("session_tree", { type: "session_tree", newLeafId: leafId, oldLeafId: null });
	}

	async start(): Promise<void> {
		await this.dispatch("session_start", { type: "session_start" });
	}

	async input(text: string): Promise<void> {
		await this.dispatch("input", { type: "input", text, source: "interactive" });
	}

	async clear(): Promise<void> {
		await this.input("/clear");
	}

	// -- internals --

	recordSend(payload: Record<string, unknown>, options: Record<string, unknown>): void {
		const sent = { payload, options };
		this.sends.push(sent);
		if (this.idle) this.appendToBranch(payload);
		else this.pending.push(sent);
	}

	private async context(): Promise<unknown[] | undefined> {
		const messages = this.branchMessages();
		this.lastContextMessages = messages;
		const out = (await this.dispatch("context", { type: "context", messages })) as { messages?: unknown[] } | undefined;
		const prompt = out?.messages;
		this.prompts.push(prompt);
		return prompt;
	}

	// One dequeued batch: before_agent_start fires at the dequeue, before any
	// input lands on the branch.
	private async startBatch(prompt: string): Promise<Record<string, unknown> | undefined> {
		const result = await this.dispatch("before_agent_start", { type: "before_agent_start", prompt, systemPrompt: [] });
		if (result === null || typeof result !== "object" || !("message" in result)) return undefined;
		if (result.message === null || typeof result.message !== "object") return undefined;
		// The handler built this payload; the fake stores it verbatim.
		return result.message as Record<string, unknown>;
	}

	// A returned payload is the batch input's tail: recorded and stored at
	// once, after the entries the batch itself appends, before the
	// boundary-flushed asides.
	private recordInjection(payload: Record<string, unknown>): void {
		this.injected.push(payload);
		this.appendToBranch(payload);
	}

	private async dispatch(event: string, payload: Record<string, unknown>): Promise<unknown> {
		const handler = this.internals.handlers.get(event);
		if (handler === undefined) return undefined;
		const previous = this.internals.current;
		this.internals.current = this;
		this.internals.last = this;
		try {
			return await handler(payload, this.ctx());
		} finally {
			this.internals.current = previous;
		}
	}

	// The harness context of this session, public so tests can drive a
	// captured definition's execute directly.
	ctx(): ExtensionContext {
		return {
			agent: { kind: this.kind },
			ui: { notify: (message: string, type?: string) => this.notices.push({ message, type }) },
			sessionManager: { getSessionId: () => this.id, getBranch: () => this.branch },
			isIdle: () => this.idle,
			getContextUsage: () => this.contextUsage,
		} as unknown as ExtensionContext;
	}

	// The message list a provider call sees: the stored entries in order,
	// custom_message entries converted the way the harness converts them —
	// `attribution` and the entry's own timestamp carried through, so a
	// rebuilt custom compares deep-equal to the projection's branch rebuild.
	private branchMessages(): unknown[] {
		const messages: unknown[] = [];
		for (const entry of this.branch) {
			if (entry.type === "message") messages.push(entry.message);
			else if (entry.type === "custom_message") {
				messages.push({ role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp: Date.parse(entry.timestamp), ...(entry.attribution === undefined ? {} : { attribution: entry.attribution }) });
			}
		}
		return messages;
	}

	private appendToBranch(payload: Record<string, unknown>): void {
		this.branch.push({
			type: "custom_message",
			id: this.nextId(),
			parentId: null,
			timestamp: new Date(0).toISOString(),
			customType: payload.customType,
			content: payload.content,
			display: payload.display,
			details: payload.details,
			// The harness's sendMessage defaults the stored attribution to
			// "agent" (session-manager appendCustomMessageEntry); the fake
			// stores the same default so rebuilt customs compare equal.
			attribution: payload.attribution ?? "agent",
		} as SessionEntry);
	}

	private flush(): void {
		for (const { payload } of this.pending) this.appendToBranch(payload);
		this.pending = [];
	}

	private messageEntry(message: Record<string, unknown>): SessionEntry {
		return { type: "message", id: this.nextId(), parentId: null, timestamp: new Date(0).toISOString(), message } as unknown as SessionEntry;
	}

	private nextId(): string {
		return `${this.id}-e${++this.seq}`;
	}
}

