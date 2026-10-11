import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Skill } from "@oh-my-pi/pi-coding-agent";
import extension from "./index";
import { OPERATING_RULES, RULES_MESSAGE_TYPE, PROCEDURE_SPEC_MESSAGE_TYPE, STATE_MESSAGE_TYPE, renderStateContent } from "./patch";
import type { ExecutionState } from "./state";
import { makeSkill } from "./skill-fixtures";

type Handler = (event: unknown, ctx: unknown) => unknown;

// Engage sends exactly these three asides; the patch loop must add nothing else.
const engageAsideTypes = [RULES_MESSAGE_TYPE, PROCEDURE_SPEC_MESSAGE_TYPE, STATE_MESSAGE_TYPE];

function skillPrompt(name: string, attribution: "user" | "agent" = "user") {
	return {
		role: "custom",
		customType: "skill-prompt",
		content: `Running skill ${name}`,
		display: true,
		timestamp: Date.now(),
		details: { name },
		attribution,
	};
}

function recordingPi(skills: Skill[]) {
	const handlers = new Map<string, Handler>();
	const sent: Array<{ payload: Record<string, unknown>; options: Record<string, unknown> }> = [];
	const renderers = new Map<string, unknown>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		sendMessage(payload: Record<string, unknown>, options: Record<string, unknown> = {}) {
			sent.push({ payload, options });
		},
		registerMessageRenderer(type: string, renderer: unknown) {
			renderers.set(type, renderer);
		},
		pi: { getActiveSkills: () => skills },
	} as unknown as ExtensionAPI;
	return { pi, handlers, sent, renderers };
}

function harness(skills: Skill[]) {
	const { pi, handlers, sent, renderers } = recordingPi(skills);
	extension(pi);
	return { handlers, sent, renderers };
}

function handler(handlers: Map<string, Handler>, event: string): Handler {
	const h = handlers.get(event);
	if (!h) throw new Error(`factory did not register a ${event} handler`);
	return h;
}

function mockCtx(sessionId: string, kind: "main" | "sub" = "main", branch: unknown[] = []) {
	const notified: Array<{ message: string; type?: string }> = [];
	const ctx = {
		agent: { kind },
		ui: {
			notify(message: string, type?: string) {
				notified.push({ message, type });
			},
		},
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
	} as unknown as ExtensionContext;
	return { ctx, notified };
}

// The harness persists a user skill invocation and our state messages as
// custom_message entries on the branch; re-derive scans exactly this shape.
function invocationEntry(name: string, attribution: "user" | "agent" = "user") {
	return {
		type: "custom_message" as const,
		id: "invocation",
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: "skill-prompt",
		content: `Running skill ${name}`,
		display: true,
		details: { name },
		attribution,
	};
}

function stateEntry(state: ExecutionState) {
	return {
		type: "custom_message" as const,
		id: "state",
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: STATE_MESSAGE_TYPE,
		content: renderStateContent(state),
		display: true,
		details: { state },
	};
}

const engageNotices = (name: string) => [
	{ message: `skill-state: procedure "${name}" engaged`, type: "info" },
	{ message: "skill-state: history is hidden from the model while engaged; finish with /new", type: "info" },
];
const disengageNotices = (name: string, trigger: string) => [
	{ message: `skill-state: procedure "${name}" disengaged (${trigger})`, type: "info" },
];

function assistantMessage(text: string) {
	return {
		type: "assistant_message",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: {},
			stopReason: "toolUse",
			timestamp: Date.now(),
		},
	};
}

function toolCall(name: string, id = "t1") {
	return { type: "tool_call", toolName: name, toolCallId: id, input: { path: "x" } };
}

let root: string;
let procedure: Skill;
let retryProcedure: Skill;
let plain: Skill;
let brokenArray: Skill;
let brokenJson: Skill;
let smallProcedure: Skill;
let idleProcedure: Skill;

beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), "omp-skill-state-"));
	procedure = await makeSkill(root, "procedure", JSON.stringify({ type: "object", properties: { goal: { type: "string" } } }));
	smallProcedure = await makeSkill(
		root,
		"smallcap",
		JSON.stringify({ type: "object", properties: { goal: { type: "string" } }, "x-state": { observationBytes: 300 } }),
	);
	retryProcedure = await makeSkill(
		root,
		"retryproc",
		JSON.stringify({ type: "object", properties: { goal: { type: "string" } }, "x-state": { retries: 2 } }),
	);
	idleProcedure = await makeSkill(
		root,
		"idleproc",
		JSON.stringify({ type: "object", properties: { goal: { type: "string" } }, "x-state": { idleSteps: 2 } }),
	);
	plain = await makeSkill(root, "plain");
	brokenArray = await makeSkill(root, "brokenarray", "[]");
	brokenJson = await makeSkill(root, "brokenjson", "{ not json");
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

async function engage(handlers: Map<string, Handler>, name: string, sessionId = "s1", kind: "main" | "sub" = "main") {
	const { ctx, notified } = mockCtx(sessionId, kind);
	await handler(handlers, "message_end")({ type: "message_end", message: skillPrompt(name) }, ctx);
	return { ctx, notified };
}

describe("omp-skill-state engage/disengage lifecycle", () => {
	test("engages on a user skill-prompt for a schema-bearing skill, with the two notices", async () => {
		const { handlers } = harness([procedure, plain]);
		const { notified } = await engage(handlers, "procedure");

		expect(notified).toEqual(engageNotices("procedure"));
	});

	test("engage sends the rules, the procedure spec and the initial state as three asides", async () => {
		const { handlers, sent } = harness([procedure]);
		await engage(handlers, "procedure");

		expect(sent).toHaveLength(3);
		const [rules, procedureSpec, state] = sent.map((s) => s.payload);
		expect(rules).toEqual({ customType: RULES_MESSAGE_TYPE, content: OPERATING_RULES, display: false });
		expect(procedureSpec).toEqual({
			customType: PROCEDURE_SPEC_MESSAGE_TYPE,
			content: "Running skill procedure",
			display: false,
			details: { name: "procedure" },
		});
		expect(state).toEqual({
			customType: STATE_MESSAGE_TYPE,
			content: renderStateContent({}),
			display: true,
			details: { state: {} },
		});
		expect(sent.map((s) => s.options)).toEqual([{ deliverAs: "aside" }, { deliverAs: "aside" }, { deliverAs: "aside" }]);
	});

	test("stays inert for a skill without a state schema", async () => {
		const { handlers } = harness([plain]);
		const { notified } = await engage(handlers, "plain");

		expect(notified).toEqual([]);
	});

	test("stays inert for an agent-attributed skill-prompt", async () => {
		const { handlers } = harness([procedure]);
		const { ctx, notified } = mockCtx("s1");
		await handler(handlers, "message_end")({ type: "message_end", message: skillPrompt("procedure", "agent") }, ctx);

		expect(notified).toEqual([]);
	});

	test("stays inert for a model skill read (toolResult message)", async () => {
		const { handlers } = harness([procedure]);
		const { ctx, notified } = mockCtx("s1");
		const message = {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [{ type: "text", text: "skill://procedure/state.schema.json" }],
			isError: false,
			timestamp: Date.now(),
		};
		await handler(handlers, "message_end")({ type: "message_end", message }, ctx);

		expect(notified).toEqual([]);
	});

	test("stays inert when the skill-prompt details carry no name", async () => {
		const { handlers } = harness([procedure]);
		const { ctx, notified } = mockCtx("s1");
		const message = { ...skillPrompt("procedure"), details: {} };
		await handler(handlers, "message_end")({ type: "message_end", message }, ctx);

		expect(notified).toEqual([]);
	});

	test("stays inert in a subagent session", async () => {
		const { handlers } = harness([procedure]);
		const { notified } = await engage(handlers, "procedure", "s1", "sub");

		expect(notified).toEqual([]);
	});

	test("stays inert when the schema file is not a JSON object", async () => {
		for (const broken of [brokenArray, brokenJson]) {
			const { handlers } = harness([broken]);
			const { notified } = await engage(handlers, broken.name);

			expect(notified).toEqual([]);
		}
	});

	test("ignores a second user invocation while engaged", async () => {
		const { handlers } = harness([procedure]);
		const first = await engage(handlers, "procedure");
		await handler(handlers, "message_end")({ type: "message_end", message: skillPrompt("procedure") }, first.ctx);

		expect(first.notified).toEqual(engageNotices("procedure"));
	});

	test("engages once when two invocations arrive before the schema read resolves", async () => {
		const { handlers } = harness([procedure]);
		const { ctx, notified } = mockCtx("s1");
		const messageEnd = handler(handlers, "message_end");

		await Promise.all([
			messageEnd({ type: "message_end", message: skillPrompt("procedure") }, ctx),
			messageEnd({ type: "message_end", message: skillPrompt("procedure") }, ctx),
		]);

		expect(notified).toEqual(engageNotices("procedure"));
	});

	test("disengages on /new", async () => {
		const { handlers } = harness([procedure]);
		const { ctx, notified } = await engage(handlers, "procedure");

		const result = await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "new" }, ctx);

		expect(result).toBeUndefined();
		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
	});

	test("disengages on /resume", async () => {
		const { handlers } = harness([procedure]);
		const { ctx, notified } = await engage(handlers, "procedure");

		const result = await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "resume" }, ctx);

		expect(result).toBeUndefined();
		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/resume")]);
	});

	test("disengages on a fork switch", async () => {
		const { handlers } = harness([procedure]);
		const { ctx, notified } = await engage(handlers, "procedure");

		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "fork" }, ctx);

		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "fork")]);
	});

	test("a rewind to before the invocation leaves the runtime inert", async () => {
		const { handlers, sent } = harness([procedure]);
		const { ctx, notified } = await engage(handlers, "procedure");

		// The harness ends the outgoing session in session_before_branch ...
		const before = await handler(handlers, "session_before_branch")(
			{ type: "session_before_branch", reason: "branch", entryId: "e1" },
			ctx,
		);
		expect(before).toBeUndefined();
		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "branch")]);

		// ... and the branched-off session is a different id with an empty branch.
		const fresh = mockCtx("s2", "main", []);
		await handler(handlers, "session_branch")({ type: "session_branch", reason: "branch", previousSessionFile: undefined }, fresh.ctx);

		expect(fresh.notified).toEqual([]);
		expect(await handler(handlers, "context")({ type: "context", messages: [skillPrompt("procedure")] }, fresh.ctx)).toBeUndefined();
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"x"}\n```'), fresh.ctx);
		expect(sent.map((s) => s.payload.customType)).toEqual(engageAsideTypes);
	});

	test("a rewind to after the invocation re-engages with the state as of that point", async () => {
		const { handlers, sent } = harness([procedure]);
		const { ctx, notified } = await engage(handlers, "procedure");

		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"x"}\n```'), ctx);
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"y"}\n```'), ctx);
		expect(sent.map((s) => s.payload.customType)).toEqual([...engageAsideTypes, STATE_MESSAGE_TYPE, STATE_MESSAGE_TYPE]);

		await handler(handlers, "session_before_branch")({ type: "session_before_branch", reason: "branch", entryId: "e1" }, ctx);
		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "branch")]);

		// The new session carries the rewound branch: invocation, initial state, goal:x.
		const fresh = mockCtx("s2", "main", [invocationEntry("procedure"), stateEntry({}), stateEntry({ goal: "x" })]);
		await handler(handlers, "session_branch")({ type: "session_branch", reason: "branch", previousSessionFile: undefined }, fresh.ctx);

		expect(fresh.notified).toEqual(engageNotices("procedure"));
		// The head asides are s1's sends; the re-derive on s2 re-sent none.
		expect(sent.map((s) => s.payload.customType)).toEqual([...engageAsideTypes, STATE_MESSAGE_TYPE, STATE_MESSAGE_TYPE]);

		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"extra":1}\n```'), fresh.ctx);
		expect(sent[sent.length - 1].payload.details).toEqual({ state: { goal: "x", extra: 1 } });
	});

	test("tree navigation re-derives like a rewind", async () => {
		const { handlers, sent } = harness([procedure]);
		const branch: unknown[] = [];
		const { ctx, notified } = mockCtx("s1", "main", branch);
		branch.push(invocationEntry("procedure"), stateEntry({}), stateEntry({ goal: "x" }));

		await handler(handlers, "session_tree")({ type: "session_tree", newLeafId: "l2", oldLeafId: "l1" }, ctx);

		expect(notified).toEqual(engageNotices("procedure"));
		expect(sent).toEqual([]);
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"extra":1}\n```'), ctx);
		expect(sent[sent.length - 1].payload.details).toEqual({ state: { goal: "x", extra: 1 } });
	});

	test("/resume of an engaged session re-derives its state and re-engages without resending the head", async () => {
		const { handlers, sent } = harness([procedure]);
		const { ctx, notified } = await engage(handlers, "procedure");

		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "resume", targetSessionFile: "s2" }, ctx);
		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/resume")]);

		const target = mockCtx("s2", "main", [invocationEntry("procedure"), stateEntry({}), stateEntry({ goal: "x" })]);
		await handler(handlers, "session_switch")({ type: "session_switch", reason: "resume", previousSessionFile: "s1" }, target.ctx);

		expect(target.notified).toEqual(engageNotices("procedure"));
		// The head asides are s1's engage sends; re-derive added none.
		expect(sent.map((s) => s.payload.customType)).toEqual(engageAsideTypes);

		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"extra":1}\n```'), target.ctx);
		expect(sent[sent.length - 1].payload.details).toEqual({ state: { goal: "x", extra: 1 } });
	});

	test("/new starts the next session inert", async () => {
		const { handlers, sent } = harness([procedure]);
		const { ctx, notified } = await engage(handlers, "procedure");

		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "new" }, ctx);
		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);

		const fresh = mockCtx("s2", "main", []);
		await handler(handlers, "session_switch")({ type: "session_switch", reason: "new", previousSessionFile: "s1" }, fresh.ctx);
		expect(fresh.notified).toEqual([]);
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"x"}\n```'), fresh.ctx);
		expect(sent.map((s) => s.payload.customType)).toEqual(engageAsideTypes);
		expect(await handler(handlers, "context")({ type: "context", messages: [skillPrompt("procedure")] }, fresh.ctx)).toBeUndefined();
	});

	test("cold session_start re-engages from the branch without resending the head", async () => {
		const { handlers, sent } = harness([procedure]);
		const { ctx, notified } = mockCtx("s1", "main", [invocationEntry("procedure"), stateEntry({ goal: "x" })]);

		await handler(handlers, "session_start")({ type: "session_start" }, ctx);

		expect(notified).toEqual(engageNotices("procedure"));
		expect(sent).toEqual([]);
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"extra":1}\n```'), ctx);
		expect(sent[sent.length - 1].payload.details).toEqual({ state: { goal: "x", extra: 1 } });
	});

	test("session_start stays inert without a usable procedure on the branch", async () => {
		const empty = harness([procedure]);
		const emptyCtx = mockCtx("s1");
		await handler(empty.handlers, "session_start")({ type: "session_start" }, emptyCtx.ctx);
		expect(emptyCtx.notified).toEqual([]);
		expect(await handler(empty.handlers, "context")({ type: "context", messages: [skillPrompt("procedure")] }, emptyCtx.ctx)).toBeUndefined();

		const agent = harness([procedure]);
		const agentCtx = mockCtx("s1", "main", [invocationEntry("procedure", "agent"), stateEntry({ goal: "x" })]);
		await handler(agent.handlers, "session_start")({ type: "session_start" }, agentCtx.ctx);
		expect(agentCtx.notified).toEqual([]);

		const schemaless = harness([plain]);
		const schemalessCtx = mockCtx("s1", "main", [invocationEntry("plain"), stateEntry({ goal: "x" })]);
		await handler(schemaless.handlers, "session_start")({ type: "session_start" }, schemalessCtx.ctx);
		expect(schemalessCtx.notified).toEqual([]);
		expect(
			await handler(schemaless.handlers, "context")({ type: "context", messages: [skillPrompt("plain")] }, schemalessCtx.ctx),
		).toBeUndefined();

		const sub = harness([procedure]);
		const subCtx = mockCtx("s1", "sub", [invocationEntry("procedure"), stateEntry({ goal: "x" })]);
		await handler(sub.handlers, "session_start")({ type: "session_start" }, subCtx.ctx);
		expect(subCtx.notified).toEqual([]);
	});

	test("a later invocation re-derives with its own state, never the earlier skill's", async () => {
		const { handlers, sent } = harness([procedure, smallProcedure]);
		const { ctx, notified } = mockCtx("s1", "main", [
			invocationEntry("procedure"),
			stateEntry({ goal: "old" }),
			invocationEntry("smallcap"),
			stateEntry({ goal: "new" }),
		]);

		await handler(handlers, "session_start")({ type: "session_start" }, ctx);

		expect(notified).toEqual(engageNotices("smallcap"));
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"extra":1}\n```'), ctx);
		expect(sent[sent.length - 1].payload.details).toEqual({ state: { goal: "new", extra: 1 } });
	});

	test("an invocation with no state message after it stays inert, even when an earlier procedure left one", async () => {
		const { handlers } = harness([procedure, smallProcedure]);
		const { ctx, notified } = mockCtx("s1", "main", [
			invocationEntry("procedure"),
			stateEntry({ goal: "old" }),
			invocationEntry("smallcap"),
		]);

		await handler(handlers, "session_start")({ type: "session_start" }, ctx);

		expect(notified).toEqual([]);
		expect(await handler(handlers, "context")({ type: "context", messages: [skillPrompt("smallcap")] }, ctx)).toBeUndefined();
	});

	test("a fork re-derives like any switch", async () => {
		const { handlers, sent } = harness([procedure]);
		const { ctx, notified } = await engage(handlers, "procedure");

		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "fork" }, ctx);
		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "fork")]);

		const fork = mockCtx("s2", "main", [invocationEntry("procedure"), stateEntry({ goal: "x" })]);
		await handler(handlers, "session_switch")({ type: "session_switch", reason: "fork", previousSessionFile: "s1" }, fork.ctx);

		expect(fork.notified).toEqual(engageNotices("procedure"));
		// The head asides are s1's engage sends; the fork's re-derive re-sent none.
		expect(sent.map((s) => s.payload.customType)).toEqual(engageAsideTypes);
	});

	test("disengages on tree navigation", async () => {
		const { handlers } = harness([procedure]);
		const { ctx, notified } = await engage(handlers, "procedure");

		await handler(handlers, "session_tree")({ type: "session_tree", newLeafId: "l2", oldLeafId: "l1" }, ctx);

		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "tree navigation")]);
	});

	test("disengages on /clear input, including padded text, and returns undefined", async () => {
		const { handlers } = harness([procedure]);
		const { ctx, notified } = await engage(handlers, "procedure");

		const result = await handler(handlers, "input")({ type: "input", text: "/clear", source: "interactive" }, ctx);
		const padded = await handler(handlers, "input")({ type: "input", text: "  /clear  ", source: "interactive" }, ctx);

		expect(result).toBeUndefined();
		expect(padded).toBeUndefined();
		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/clear")]);
	});

	test("ignores input that is not exactly /clear and returns undefined", async () => {
		const { handlers } = harness([procedure]);
		const { ctx, notified } = await engage(handlers, "procedure");

		for (const text of ["/clearx", "hello"]) {
			const result = await handler(handlers, "input")({ type: "input", text, source: "interactive" }, ctx);
			expect(result).toBeUndefined();
		}

		expect(notified).toEqual(engageNotices("procedure"));
	});

	test("a repeated trigger after disengage notifies nothing", async () => {
		const { handlers } = harness([procedure]);
		const { ctx, notified } = await engage(handlers, "procedure");
		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "new" }, ctx);

		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "new" }, ctx);

		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
	});

	test("triggers while not engaged notify nothing", async () => {
		const { handlers } = harness([procedure]);
		const { ctx, notified } = mockCtx("s1");

		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "new" }, ctx);
		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "resume" }, ctx);
		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "fork" }, ctx);
		await handler(handlers, "session_before_branch")({ type: "session_before_branch", reason: "branch", entryId: "e1" }, ctx);
		await handler(handlers, "session_branch")({ type: "session_branch", reason: "branch", previousSessionFile: undefined }, ctx);
		await handler(handlers, "session_tree")({ type: "session_tree", newLeafId: null, oldLeafId: null }, ctx);
		await handler(handlers, "input")({ type: "input", text: "/clear", source: "interactive" }, ctx);

		expect(notified).toEqual([]);
	});

	test("engagement in session A is invisible to session B", async () => {
		const { handlers } = harness([procedure]);
		const a = await engage(handlers, "procedure", "A");
		const b = mockCtx("B");

		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "new" }, b.ctx);

		expect(b.notified).toEqual([]);
		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "new" }, a.ctx);
		expect(a.notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
	});

	test("sessions A and B engage and disengage independently", async () => {
		const { handlers } = harness([procedure]);
		const a = await engage(handlers, "procedure", "A");
		const b = await engage(handlers, "procedure", "B");

		await handler(handlers, "session_tree")({ type: "session_tree", newLeafId: null, oldLeafId: null }, b.ctx);
		expect(b.notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "tree navigation")]);

		await handler(handlers, "session_tree")({ type: "session_tree", newLeafId: null, oldLeafId: null }, a.ctx);
		expect(a.notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "tree navigation")]);
	});

	test("the bundled recon skill engages end to end", async () => {
		const baseDir = path.join(import.meta.dir, "skills", "recon");
		const recon: Skill = {
			name: "recon",
			description: "bundled sample procedure skill",
			filePath: path.join(baseDir, "SKILL.md"),
			baseDir,
			source: "test",
		};
		const { handlers } = harness([recon]);
		const { notified } = await engage(handlers, "recon");

		expect(notified).toEqual(engageNotices("recon"));
	});
});

async function patchHarness(skill: Skill) {
	const { handlers, sent } = harness([skill]);
	const { ctx, notified } = await engage(handlers, skill.name);
	// sent starts with the three engage asides (rules, P, initial t); patch tests
	// index past them.
	return { handlers, sent, ctx, notified };
}

function stateMessage(state: ExecutionState) {
	return {
		role: "custom",
		customType: STATE_MESSAGE_TYPE,
		content: renderStateContent(state),
		display: true,
		details: { state },
		timestamp: Date.now(),
	};
}

function renderWith(theme: { fg: (color: string, text: string) => string }, expanded: boolean, state: ExecutionState) {
	const renderer = harness([procedure]).renderers.get(STATE_MESSAGE_TYPE) as
		| ((message: unknown, options: { expanded: boolean }, theme: unknown) => { getText(): string })
		| undefined;
	expect(renderer).toBeDefined();
	return renderer!(stateMessage(state), { expanded }, theme).getText();
}

describe("omp-skill-state patch loop", () => {
	test("the renderer shows keys collapsed and pretty JSON expanded, never the raw one-liner", () => {
		const theme = { fg: (_color: string, text: string) => text };

		const collapsed = renderWith(theme, false, { goal: "g" });
		expect(collapsed).toContain("goal");
		expect(collapsed).not.toContain('{"goal":"g"}');

		const expanded = renderWith(theme, true, { goal: "g" });
		expect(expanded).toContain('"goal": "g"');
	});

	test("no patch block is an empty patch: nothing sent, tool calls run", async () => {
		const { handlers, sent, ctx } = await patchHarness(procedure);

		const rewritten = await handler(handlers, "assistant_message")(assistantMessage("Prose only, calling a tool."), ctx);
		const blocked = await handler(handlers, "tool_call")(toolCall("read"), ctx);

		expect(rewritten).toBeUndefined();
		expect(sent.map((s) => s.payload.customType)).toEqual(engageAsideTypes);
		expect(blocked).toBeUndefined();
	});

	test("a valid patch is merged and sent as a state message, aside", async () => {
		const { handlers, sent, ctx } = await patchHarness(procedure);

		const rewritten = await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"x"}\n```'), ctx);
		const blocked = await handler(handlers, "tool_call")(toolCall("read"), ctx);

		expect(rewritten).toBeUndefined();
		expect(sent).toHaveLength(4);
		expect(sent[3].payload.customType).toBe(STATE_MESSAGE_TYPE);
		expect(sent[3].options.deliverAs).toBe("aside");
		expect(sent[3].payload.details).toEqual({ state: { goal: "x" } });
		expect(sent[3].payload.content).toBe(renderStateContent({ goal: "x" }));
		expect(blocked).toBeUndefined();
	});

	test("a second valid patch merges into the first instead of replacing it", async () => {
		const { handlers, sent, ctx } = await patchHarness(procedure);

		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"x"}\n```'), ctx);
		await handler(handlers, "assistant_message")(assistantMessage("```json state\n{\"extra\": 1}\n```"), ctx);

		expect(sent).toHaveLength(5);
		expect(sent[4].payload.details).toEqual({ state: { goal: "x", extra: 1 } });
	});

	test("an invalid patch blocks every tool call with the validation error and sends nothing", async () => {
		const { handlers, sent, ctx } = await patchHarness(procedure);

		const rewritten = await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal": 42}\n```'), ctx);
		const read = await handler(handlers, "tool_call")(toolCall("read", "t1"), ctx);
		const bash = await handler(handlers, "tool_call")(toolCall("bash", "t2"), ctx);

		expect(rewritten).toBeUndefined();
		expect(sent.map((s) => s.payload.customType)).toEqual(engageAsideTypes);
		expect(read).toEqual({ block: true, reason: expect.stringContaining("goal") });
		expect(bash).toEqual({ block: true, reason: expect.stringContaining("goal") });
	});

	test("malformed JSON blocks with the parse error", async () => {
		const { handlers, sent, ctx } = await patchHarness(procedure);

		await handler(handlers, "assistant_message")(assistantMessage("```json state\n{ nope\n```"), ctx);
		const blocked = await handler(handlers, "tool_call")(toolCall("read"), ctx);

		expect(sent.map((s) => s.payload.customType)).toEqual(engageAsideTypes);
		expect(blocked).toEqual({ block: true, reason: expect.stringContaining("valid JSON") });
	});

	test("a valid retry recovers and the session stays engaged", async () => {
		const { handlers, sent, ctx, notified } = await patchHarness(procedure);

		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal": 42}\n```'), ctx);
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"x"}\n```'), ctx);

		const blocked = await handler(handlers, "tool_call")(toolCall("read"), ctx);
		expect(blocked).toBeUndefined();
		expect(sent).toHaveLength(4); // engage asides plus the recovered state message

		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "new" }, ctx);
		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
	});

	test("the third consecutive invalid patch degrades and the session runs ordinarily", async () => {
		const { handlers, sent, ctx, notified } = await patchHarness(procedure);

		for (let i = 0; i < 3; i++) {
			await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal": 42}\n```'), ctx);
		}

		expect(notified).toEqual([
			...engageNotices("procedure"),
			{ message: 'skill-state: procedure "procedure" degraded after 3 invalid patches; running ordinarily', type: "warning" },
		]);

		const blocked = await handler(handlers, "tool_call")(toolCall("read"), ctx);
		expect(blocked).toBeUndefined();

		const rewritten = await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal": 42}\n```'), ctx);
		const later = await handler(handlers, "tool_call")(toolCall("read", "t9"), ctx);
		expect(rewritten).toBeUndefined();
		expect(later).toBeUndefined();

		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "new" }, ctx);
		expect(notified).toEqual([
			...engageNotices("procedure"),
			{ message: 'skill-state: procedure "procedure" degraded after 3 invalid patches; running ordinarily', type: "warning" },
		]);
		expect(sent.map((s) => s.payload.customType)).toEqual(engageAsideTypes);
	});

	test("the degrade threshold honours x-state retries", async () => {
		const { handlers, ctx, notified } = await patchHarness(retryProcedure);

		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal": 42}\n```'), ctx);
		expect(notified).toEqual(engageNotices("retryproc"));

		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal": 42}\n```'), ctx);
		expect(notified).toEqual([
			...engageNotices("retryproc"),
			{ message: 'skill-state: procedure "retryproc" degraded after 2 invalid patches; running ordinarily', type: "warning" },
		]);
	});

	test("a valid patch between failures resets the consecutive counter", async () => {
		const { handlers, ctx, notified } = await patchHarness(procedure);

		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal": 42}\n```'), ctx);
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal": 42}\n```'), ctx);
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"x"}\n```'), ctx);
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal": 42}\n```'), ctx);
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal": 42}\n```'), ctx);

		expect(notified).toEqual(engageNotices("procedure"));

		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "new" }, ctx);
		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
	});

	test("assistant_message and tool_call are inert when not engaged and in a subagent", async () => {
		const { handlers, sent } = harness([procedure]);

		const main = mockCtx("s1");
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"x"}\n```'), main.ctx);
		const mainBlocked = await handler(handlers, "tool_call")(toolCall("read"), main.ctx);
		expect(sent).toEqual([]);
		expect(mainBlocked).toBeUndefined();
		expect(main.notified).toEqual([]);

		const sub = mockCtx("s2", "sub");
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"x"}\n```'), sub.ctx);
		const subBlocked = await handler(handlers, "tool_call")(toolCall("read"), sub.ctx);
		expect(sent).toEqual([]);
		expect(subBlocked).toBeUndefined();
		expect(sub.notified).toEqual([]);
	});
});

describe("omp-skill-state idle disengage", () => {
	test("three consecutive no-patch steps disengage; two stay engaged", async () => {
		const { handlers, ctx, notified } = await patchHarness(procedure);

		await handler(handlers, "assistant_message")(assistantMessage("step 1"), ctx);
		await handler(handlers, "assistant_message")(assistantMessage("step 2"), ctx);
		expect(notified).toEqual(engageNotices("procedure"));

		await handler(handlers, "assistant_message")(assistantMessage("step 3"), ctx);
		expect(notified).toEqual([
			...engageNotices("procedure"),
			{ message: 'skill-state: procedure "procedure" disengaged (idle for 3 steps)', type: "info" },
		]);
	});

	test("the idle threshold honours x-state idleSteps", async () => {
		const { handlers, ctx, notified } = await patchHarness(idleProcedure);

		await handler(handlers, "assistant_message")(assistantMessage("step 1"), ctx);
		expect(notified).toEqual(engageNotices("idleproc"));

		await handler(handlers, "assistant_message")(assistantMessage("step 2"), ctx);
		expect(notified).toEqual([
			...engageNotices("idleproc"),
			{ message: 'skill-state: procedure "idleproc" disengaged (idle for 2 steps)', type: "info" },
		]);
	});

	test("a valid patch between idle steps resets the idle run", async () => {
		const { handlers, ctx, notified } = await patchHarness(procedure);

		await handler(handlers, "assistant_message")(assistantMessage("no patch"), ctx);
		await handler(handlers, "assistant_message")(assistantMessage("no patch"), ctx);
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"x"}\n```'), ctx);
		await handler(handlers, "assistant_message")(assistantMessage("no patch"), ctx);
		await handler(handlers, "assistant_message")(assistantMessage("no patch"), ctx);

		expect(notified).toEqual(engageNotices("procedure"));
	});

	test("an invalid patch also resets the idle run", async () => {
		const { handlers, ctx, notified } = await patchHarness(procedure);

		await handler(handlers, "assistant_message")(assistantMessage("no patch"), ctx);
		await handler(handlers, "assistant_message")(assistantMessage("no patch"), ctx);
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal": 42}\n```'), ctx);
		await handler(handlers, "assistant_message")(assistantMessage("no patch"), ctx);
		await handler(handlers, "assistant_message")(assistantMessage("no patch"), ctx);

		expect(notified).toEqual(engageNotices("procedure"));
	});

	test("after an idle disengage the step is ordinary", async () => {
		const { handlers, sent, ctx, notified } = await patchHarness(idleProcedure);

		await handler(handlers, "assistant_message")(assistantMessage("step 1"), ctx);
		await handler(handlers, "assistant_message")(assistantMessage("step 2"), ctx);
		expect(notified).toEqual([
			...engageNotices("idleproc"),
			...disengageNotices("idleproc", "idle for 2 steps"),
		]);

		const blocked = await handler(handlers, "tool_call")(toolCall("read"), ctx);
		expect(blocked).toBeUndefined();
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"x"}\n```'), ctx);
		expect(sent.map((s) => s.payload.customType)).toEqual(engageAsideTypes);
	});
});

describe("omp-skill-state compaction ownership", () => {
	// The shape SessionBeforeCompactResult takes through this suite's seams; the
	// harness stores handlers as unknown-taking functions, so the event shape and
	// result type live here once instead of at every call.
	interface CompactionOutput {
		compaction?: {
			summary: string;
			shortSummary?: string;
			firstKeptEntryId: string;
			tokensBefore: number;
			preserveData?: unknown;
		};
	}

	async function compact(
		handlers: Map<string, Handler>,
		ctx: ExtensionContext,
		preparation: Record<string, unknown>,
	): Promise<CompactionOutput | undefined> {
		const result = await handler(handlers, "session_before_compact")(
			{ type: "session_before_compact", preparation, signal: new AbortController().signal, branchEntries: [] },
			ctx,
		);
		return result as CompactionOutput | undefined;
	}

	test("registers session_before_compact lazily on the first engage, never at load", async () => {
		const { handlers } = harness([procedure]);
		expect(handlers.has("session_before_compact")).toBe(false);

		await engage(handlers, "procedure");

		expect(handlers.has("session_before_compact")).toBe(true);
	});

	test("engaged compaction returns the state summary built from the harness preparation", async () => {
		const { handlers, sent } = harness([procedure]);
		const { ctx } = await engage(handlers, "procedure");
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"g"}\n```'), ctx);

		const result = await compact(handlers, ctx, { firstKeptEntryId: "e7", tokensBefore: 4321 });

		const compaction = result?.compaction;
		expect(compaction?.firstKeptEntryId).toBe("e7");
		expect(compaction?.tokensBefore).toBe(4321);
		expect(compaction?.summary).toContain('Execution state of procedure "procedure"');
		expect(compaction?.summary).toContain(renderStateContent({ goal: "g" }));
		expect(compaction?.shortSummary).toContain('"procedure"');
		expect(compaction?.preserveData).toEqual({ state: { goal: "g" } });
		// No summarizer step: compaction adds no sends beyond the patch loop's own.
		expect(sent.map((s) => s.payload.customType)).toEqual([...engageAsideTypes, STATE_MESSAGE_TYPE]);
	});

	test("a second compaction carries the live state, not an echo of previousPreserveData", async () => {
		const { handlers } = harness([procedure]);
		const { ctx } = await engage(handlers, "procedure");
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"g"}\n```'), ctx);

		const first = await compact(handlers, ctx, { firstKeptEntryId: "e7", tokensBefore: 4321 });
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"step":2}\n```'), ctx);
		const second = await compact(handlers, ctx, {
			firstKeptEntryId: "e9",
			tokensBefore: 5000,
			previousPreserveData: first?.compaction?.preserveData,
		});

		expect(first?.compaction?.preserveData).toEqual({ state: { goal: "g" } });
		expect(second?.compaction?.firstKeptEntryId).toBe("e9");
		expect(second?.compaction?.preserveData).toEqual({ state: { goal: "g", step: 2 } });
	});

	test("yields to the harness default when never engaged, in a subagent, or after disengage", async () => {
		const { handlers } = harness([procedure]);
		// Engaging s2 registers the process-wide handler; s1 has never engaged.
		await engage(handlers, "procedure", "s2");
		const never = mockCtx("s1");
		expect(await compact(handlers, never.ctx, { firstKeptEntryId: "e1", tokensBefore: 1 })).toBeUndefined();

		const { ctx, notified } = await engage(handlers, "procedure");
		const sub = mockCtx("s1", "sub");
		expect(await compact(handlers, sub.ctx, { firstKeptEntryId: "e2", tokensBefore: 2 })).toBeUndefined();

		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "new" }, ctx);
		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
		expect(await compact(handlers, ctx, { firstKeptEntryId: "e3", tokensBefore: 3 })).toBeUndefined();
	});
});

describe("omp-skill-state projection (context seam)", () => {
	function contextEvent(messages: unknown[]) {
		return { type: "context", messages };
	}

	function projected(out: unknown) {
		return (out as { messages: Array<Record<string, unknown>> } | undefined)?.messages;
	}

	test("returns undefined for a subagent session and when not engaged", async () => {
		const { handlers } = harness([procedure]);
		const sub = mockCtx("s1", "sub");
		const main = mockCtx("s2");

		expect(await handler(handlers, "context")(contextEvent([skillPrompt("procedure")]), sub.ctx)).toBeUndefined();
		expect(await handler(handlers, "context")(contextEvent([skillPrompt("procedure")]), main.ctx)).toBeUndefined();
	});

	test("engaged: projects head plus the current step and honours x-state observationBytes", async () => {
		const { handlers, sent } = harness([smallProcedure]);
		const { ctx } = await engage(handlers, "smallcap");
		// As payloads lack role: the harness normalization adds it before the
		// message reaches context, so the fixture does too.
		const headCustoms = sent.slice(0, 3).map((s) => ({ role: "custom", ...s.payload }));
		const call = {
			...assistantMessage("working").message,
			content: [{ type: "toolCall", id: "call-7", name: "read", arguments: {} }],
		};
		const result = {
			role: "toolResult",
			toolCallId: "call-7",
			toolName: "read",
			content: [{ type: "text", text: "y".repeat(1000) }],
			isError: false,
			timestamp: Date.now(),
		};
		const messages = [
			{ role: "user", content: "old turn", timestamp: Date.now() },
			assistantMessage("old reply").message,
			...headCustoms,
			call,
			result,
		];
		const out = await handler(handlers, "context")(contextEvent(messages), ctx);
		const outMessages = projected(out)!;

		expect(outMessages).toHaveLength(5);
		expect(outMessages[0]).toBe(headCustoms[0]);
		expect(outMessages[1]).toBe(headCustoms[1]);
		expect(outMessages[2]).toBe(headCustoms[2]);
		expect(outMessages[3]).toBe(call);
		const capped = outMessages[4] as { content: Array<{ type: string; text?: string }>; toolCallId: string };
		expect(capped.toolCallId).toBe("call-7");
		const total = capped.content.reduce(
			(sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text ?? "") : 0),
			0,
		);
		expect(total).toBeLessThanOrEqual(300);
		expect(capped.content.at(-1)?.text).toContain("observation cap 300 bytes exceeded");
	});

	test("engaged: a user turn projects head plus the user message", async () => {
		const { handlers, sent } = harness([procedure]);
		const { ctx } = await engage(handlers, "procedure");
		const headCustoms = sent.slice(0, 3).map((s) => ({ role: "custom", ...s.payload }));
		const turn = { role: "user", content: "go on", timestamp: Date.now() };
		const messages = [...headCustoms, turn];

		const out = await handler(handlers, "context")(contextEvent(messages), ctx);
		const outMessages = projected(out)!;

		expect(outMessages).toHaveLength(4);
		expect(outMessages[3]).toBe(turn);
	});

	test("the context handler never mutates event.messages, even when it truncates", async () => {
		const { handlers, sent } = harness([smallProcedure]);
		const { ctx } = await engage(handlers, "smallcap");
		const headCustoms = sent.slice(0, 3).map((s) => ({ role: "custom", ...s.payload }));
		const call = {
			...assistantMessage("working").message,
			content: [{ type: "toolCall", id: "call-7", name: "read", arguments: {} }],
		};
		const result = {
			role: "toolResult",
			toolCallId: "call-7",
			toolName: "read",
			content: [{ type: "text", text: "y".repeat(1000) }],
			isError: false,
			timestamp: Date.now(),
		};
		const messages = [...headCustoms, call, result];
		const snapshot = structuredClone(messages);

		const out = await handler(handlers, "context")(contextEvent(messages), ctx);

		expect(projected(out)![4]).not.toBe(result);
		expect(messages).toEqual(snapshot);
	});
});
