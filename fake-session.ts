import type { ExtensionAPI, ExtensionContext, SessionEntry, Skill } from "@oh-my-pi/pi-coding-agent";
import extension from "./index";
import { PROCEDURE_SPEC_MESSAGE_TYPE, STATE_MESSAGE_TYPE, renderStateContent } from "./messages";
import { isPlainObject } from "./state";
import type { ExecutionState } from "./state";

// A fake omp session for the adapter tests: one factory (one handler map) with
// N sessions keyed by id. Each session owns its branch, sends, notices, idle
// flag and blocked calls, and auto-dispatches the harness's event order inside
// one verb. The fidelity model, small enough to audit against
// docs/extensions.md:
//
// - step() dispatches context, then assistant_message, then tool_call per
//   call, then stores the reply and its results on the branch, then flushes
//   pending messages.
// - A message sent while busy flushes at the end of the current step, so the
//   first step after engage carries no head: the engage asides land at the
//   first step boundary (spec section 11.4), and the step after a compaction
//   can run before the re-sent head lands.
// - A message sent while idle is appended to the branch at once: "aside" would
//   start a turn in the real harness and "nextTurn" is appended without one,
//   which is what the settle poll and the idle compaction rely on.
// - A reply with no tool call ends the run: agent_end fires.
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
}

export function fakeOmp(skills: Skill[]): FakeOmp {
	const internals: Internals = { handlers: new Map(), renderers: new Map() };
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
		pi: { getActiveSkills: () => skills },
	} as unknown as ExtensionAPI;
	extension(pi);
	const sessions = new Map<string, FakeSession>();
	return {
		renderers: internals.renderers,
		registered: (event: string) => internals.handlers.has(event),
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

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export class FakeSession {
	readonly id: string;
	readonly kind: "main" | "sub";
	// The stored entries from the session root to the current leaf.
	branch: SessionEntry[];
	// Every sendMessage as the factory made it, in order.
	sends: Sent[] = [];
	notices: Array<{ message: string; type?: string }> = [];
	blocked: BlockedCall[] = [];
	// The projection result of each provider call, in order; undefined when the
	// call ran on ordinary context.
	prompts: Array<unknown[] | undefined> = [];
	// The message list the last context event received, as the fake built it.
	lastContextMessages: unknown[] | undefined;
	lastCompaction: CompactionOutput | undefined;
	idle = false;
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

	// The state of every stored state message, in order.
	get storedStates(): ExecutionState[] {
		const states: ExecutionState[] = [];
		for (const entry of this.branch) {
			if (entry.type !== "custom_message" || entry.customType !== STATE_MESSAGE_TYPE) continue;
			const details = entry.details as { state?: unknown } | undefined;
			if (details !== undefined && isPlainObject(details.state)) states.push(details.state as ExecutionState);
		}
		return states;
	}

	// The projection result of the latest provider call.
	get prompt(): unknown[] | undefined {
		return this.prompts.at(-1);
	}

	setIdle(value: boolean): void {
		this.idle = value;
	}

	// A user skill invocation: the harness stores the skill-prompt message and
	// fires message_end; a schema-bearing skill engages.
	async invoke(name: string, opts: { attribution?: "user" | "agent"; details?: unknown } = {}): Promise<void> {
		const content = `Running skill ${name}`;
		const details = opts.details ?? { name };
		const attribution = opts.attribution ?? "user";
		const message = { role: "custom", customType: "skill-prompt", content, display: true, timestamp: Date.now(), details, attribution };
		this.branch.push({
			type: "custom_message",
			id: this.nextId(),
			parentId: null,
			timestamp: new Date(0).toISOString(),
			customType: "skill-prompt",
			content,
			display: true,
			details,
			attribution,
		} as SessionEntry);
		await this.dispatch("message_end", { type: "message_end", message });
	}

	// A message_end for anything else: a model skill read, a foreign message.
	async endMessage(message: Record<string, unknown>): Promise<void> {
		await this.dispatch("message_end", { type: "message_end", message });
	}

	// One step: context, reply, tool calls, storage, flush. A reply with no
	// tool call ends the run. Returns the projection result of the context call.
	async step(text: string, opts: { tools?: string[]; results?: string[] } = {}): Promise<unknown[] | undefined> {
		const tools = opts.tools ?? ["read"];
		const prompt = await this.context();
		const calls = tools.map((name) => ({ name, id: `call-${++this.seq}` }));
		const message: Record<string, unknown> = {
			role: "assistant",
			content: [{ type: "text", text }, ...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} }))],
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
			stored.push(
				this.messageEntry({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: opts.results?.[i] ?? "ok" }],
					isError: false,
					timestamp: Date.now(),
				}),
			);
		}
		this.branch.push(...stored);
		this.flush();
		if (calls.length === 0) await this.dispatch("agent_end", { type: "agent_end", messages: [] });
		return prompt;
	}

	// A user prompt arriving mid-run: a context call whose message list ends in
	// the user turn. No reply follows; the test asserts what the model would see.
	async userTurn(text: string): Promise<unknown[] | undefined> {
		const messages = [...this.branchMessages(), { role: "user", content: text, timestamp: Date.now() }];
		this.lastContextMessages = messages;
		const out = (await this.dispatch("context", { type: "context", messages })) as { messages?: unknown[] } | undefined;
		const prompt = out?.messages;
		this.prompts.push(prompt);
		return prompt;
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

	private ctx(): ExtensionContext {
		return {
			agent: { kind: this.kind },
			ui: { notify: (message: string, type?: string) => this.notices.push({ message, type }) },
			sessionManager: { getSessionId: () => this.id, getBranch: () => this.branch },
			isIdle: () => this.idle,
		} as unknown as ExtensionContext;
	}

	// The message list a provider call sees: the stored entries in order.
	private branchMessages(): unknown[] {
		const messages: unknown[] = [];
		for (const entry of this.branch) {
			if (entry.type === "message") messages.push(entry.message);
			else if (entry.type === "custom_message") {
				messages.push({ role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp: Date.now() });
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

// -- branch entry builders, for seeding a session with a stored procedure --

let seedSeq = 0;
const seedId = () => `seed-${++seedSeq}`;

export function invocationEntry(name: string, attribution: "user" | "agent" = "user", details: unknown = { name }): SessionEntry {
	return {
		type: "custom_message",
		id: seedId(),
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: "skill-prompt",
		content: `Running skill ${name}`,
		display: true,
		details,
		attribution,
	} as SessionEntry;
}

export function specEntry(name: string): SessionEntry {
	return {
		type: "custom_message",
		id: seedId(),
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: PROCEDURE_SPEC_MESSAGE_TYPE,
		content: `Running skill ${name}`,
		display: false,
		details: { name },
	} as SessionEntry;
}

export function stateEntry(state: ExecutionState, details: unknown = { state }): SessionEntry {
	return {
		type: "custom_message",
		id: seedId(),
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: STATE_MESSAGE_TYPE,
		content: renderStateContent(state),
		display: true,
		details,
	} as SessionEntry;
}

// What an engaged run leaves on the branch: the invocation, then the head
// asides, then one state entry per accepted patch.
export function procedureBranch(name: string, ...states: ExecutionState[]): SessionEntry[] {
	return [invocationEntry(name), specEntry(name), ...states.map((state) => stateEntry(state))];
}
