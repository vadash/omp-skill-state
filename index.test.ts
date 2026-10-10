import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Skill } from "@oh-my-pi/pi-coding-agent";
import extension from "./index";

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
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		pi: { getActiveSkills: () => skills },
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

function harness(skills: Skill[]) {
	const { pi, handlers } = recordingPi(skills);
	extension(pi);
	return { handlers };
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

let root: string;
let procedure: Skill;
let plain: Skill;
let brokenArray: Skill;
let brokenJson: Skill;

async function makeSkill(name: string, schema?: string): Promise<Skill> {
	const baseDir = path.join(root, name);
	await mkdir(baseDir);
	await writeFile(path.join(baseDir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill ${name}\n---\n\nBody of ${name}.\n`);
	if (schema !== undefined) await writeFile(path.join(baseDir, "state.schema.json"), schema);
	return { name, description: `test skill ${name}`, filePath: path.join(baseDir, "SKILL.md"), baseDir, source: "test" };
}

beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), "omp-skill-state-"));
	procedure = await makeSkill("procedure", JSON.stringify({ type: "object", properties: { goal: { type: "string" } } }));
	plain = await makeSkill("plain");
	brokenArray = await makeSkill("brokenarray", "[]");
	brokenJson = await makeSkill("brokenjson", "{ not json");
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
