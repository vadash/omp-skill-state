import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Skill } from "@oh-my-pi/pi-coding-agent";
import extension from "./index";
import { STATE_MESSAGE_TYPE, renderStateContent } from "./patch";
import type { ExecutionState } from "./state";
import { makeSkill } from "./skill-fixtures";

type Handler = (event: unknown, ctx: unknown) => unknown;

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

function mockCtx(sessionId: string, kind: "main" | "sub" = "main") {
	const notified: Array<{ message: string; type?: string }> = [];
	const ctx = {
		agent: { kind },
		ui: {
			notify(message: string, type?: string) {
				notified.push({ message, type });
			},
		},
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;
	return { ctx, notified };
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

beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), "omp-skill-state-"));
	procedure = await makeSkill(root, "procedure", JSON.stringify({ type: "object", properties: { goal: { type: "string" } } }));
	retryProcedure = await makeSkill(
		root,
		"retryproc",
		JSON.stringify({ type: "object", properties: { goal: { type: "string" } }, "x-state": { retries: 2 } }),
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

		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "resume" }, ctx);

		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/resume")]);
	});

	test("disengages on a fork switch", async () => {
		const { handlers } = harness([procedure]);
		const { ctx, notified } = await engage(handlers, "procedure");

		await handler(handlers, "session_before_switch")({ type: "session_before_switch", reason: "fork" }, ctx);

		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "fork")]);
	});

	test("disengages on a branch", async () => {
		const { handlers } = harness([procedure]);
		const { ctx, notified } = await engage(handlers, "procedure");

		await handler(handlers, "session_branch")({ type: "session_branch", reason: "branch", previousSessionFile: undefined }, ctx);

		expect(notified).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "branch")]);
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
		expect(sent).toEqual([]);
		expect(blocked).toBeUndefined();
	});

	test("a valid patch is merged and sent as a state message, aside", async () => {
		const { handlers, sent, ctx } = await patchHarness(procedure);

		const rewritten = await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"x"}\n```'), ctx);
		const blocked = await handler(handlers, "tool_call")(toolCall("read"), ctx);

		expect(rewritten).toBeUndefined();
		expect(sent).toHaveLength(1);
		expect(sent[0].payload.customType).toBe(STATE_MESSAGE_TYPE);
		expect(sent[0].options.deliverAs).toBe("aside");
		expect(sent[0].payload.details).toEqual({ state: { goal: "x" } });
		expect(sent[0].payload.content).toBe(renderStateContent({ goal: "x" }));
		expect(blocked).toBeUndefined();
	});

	test("a second valid patch merges into the first instead of replacing it", async () => {
		const { handlers, sent, ctx } = await patchHarness(procedure);

		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"x"}\n```'), ctx);
		await handler(handlers, "assistant_message")(assistantMessage("```json state\n{\"extra\": 1}\n```"), ctx);

		expect(sent).toHaveLength(2);
		expect(sent[1].payload.details).toEqual({ state: { goal: "x", extra: 1 } });
	});

	test("an invalid patch blocks every tool call with the validation error and sends nothing", async () => {
		const { handlers, sent, ctx } = await patchHarness(procedure);

		const rewritten = await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal": 42}\n```'), ctx);
		const read = await handler(handlers, "tool_call")(toolCall("read", "t1"), ctx);
		const bash = await handler(handlers, "tool_call")(toolCall("bash", "t2"), ctx);

		expect(rewritten).toBeUndefined();
		expect(sent).toEqual([]);
		expect(read).toEqual({ block: true, reason: expect.stringContaining("goal") });
		expect(bash).toEqual({ block: true, reason: expect.stringContaining("goal") });
	});

	test("malformed JSON blocks with the parse error", async () => {
		const { handlers, sent, ctx } = await patchHarness(procedure);

		await handler(handlers, "assistant_message")(assistantMessage("```json state\n{ nope\n```"), ctx);
		const blocked = await handler(handlers, "tool_call")(toolCall("read"), ctx);

		expect(sent).toEqual([]);
		expect(blocked).toEqual({ block: true, reason: expect.stringContaining("valid JSON") });
	});

	test("a valid retry recovers and the session stays engaged", async () => {
		const { handlers, sent, ctx, notified } = await patchHarness(procedure);

		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal": 42}\n```'), ctx);
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"x"}\n```'), ctx);

		const blocked = await handler(handlers, "tool_call")(toolCall("read"), ctx);
		expect(blocked).toBeUndefined();
		expect(sent).toHaveLength(1);

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
		expect(sent).toEqual([]);
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
