import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Skill } from "@oh-my-pi/pi-coding-agent";
import { fakeOmp, invocationEntry, procedureBranch, specEntry, stateEntry } from "./fake-session";
import extension from "./index";
import { RULES_MESSAGE_TYPE, PROCEDURE_SPEC_MESSAGE_TYPE, STATE_MESSAGE_TYPE, renderStateContent, stateMessage } from "./messages";
import { OPERATING_RULES } from "./patch";
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

// One pi.sendMessage call as the factory made it.
interface Sent {
	payload: Record<string, unknown>;
	options: Record<string, unknown>;
}

function recordingPi(skills: Skill[]) {
	const handlers = new Map<string, Handler>();
	const sent: Sent[] = [];
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

function mockCtx(sessionId: string, kind: "main" | "sub" = "main", branch: unknown[] = [], idle = false) {
	const notified: Array<{ message: string; type?: string }> = [];
	const live = { idle };
	const ctx = {
		agent: { kind },
		ui: {
			notify(message: string, type?: string) {
				notified.push({ message, type });
			},
		},
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
		isIdle: () => live.idle,
	} as unknown as ExtensionContext;
	const setIdle = (value: boolean) => {
		live.idle = value;
	};
	return { ctx, notified, setIdle };
}

const engageNotices = (name: string) => [
	{ message: `skill-state: procedure "${name}" engaged`, type: "info" },
	{ message: "skill-state: history is hidden from the model while engaged; finish with /new", type: "info" },
];
const disengageNotices = (name: string, trigger: string) => [
	{ message: `skill-state: procedure "${name}" disengaged (${trigger})`, type: "info" },
];

// A live step: the model's text plus one tool call, which is what keeps the
// run going. A step without a tool call is the run's last.
function assistantMessage(text: string, toolCallId = "call-1") {
	return {
		type: "assistant_message",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text },
				{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "x" } },
			],
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
	const { ctx, notified, setIdle } = mockCtx(sessionId, kind);
	await handler(handlers, "message_end")({ type: "message_end", message: skillPrompt(name) }, ctx);
	return { ctx, notified, setIdle };
}

describe("omp-skill-state engage/disengage lifecycle", () => {
	const patch = (json: string) => `\`\`\`json state\n${json}\n\`\`\``;

	// A session that has invoked the procedure skill: engaged, head asides
	// pending until the first step boundary.
	async function engaged(skills: Skill[] = [procedure], id = "s1") {
		const omp = fakeOmp(skills);
		const s = omp.session(id);
		await s.invoke("procedure");
		return { omp, s };
	}

	test("engages on a user skill-prompt for a schema-bearing skill, with the two notices", async () => {
		const { s } = await engaged([procedure, plain]);

		expect(s.notices).toEqual(engageNotices("procedure"));
	});

	test("engage sends the rules, the procedure spec and the initial state as three asides", async () => {
		const { s } = await engaged();

		expect(s.sends.map((sent) => sent.payload)).toEqual([
			{ customType: RULES_MESSAGE_TYPE, content: OPERATING_RULES, display: false },
			{ customType: PROCEDURE_SPEC_MESSAGE_TYPE, content: "Running skill procedure", display: false, details: { name: "procedure" } },
			{ customType: STATE_MESSAGE_TYPE, content: renderStateContent({}), display: true, details: { state: {} } },
		]);
		expect(s.sends.map((sent) => sent.options)).toEqual([{ deliverAs: "aside" }, { deliverAs: "aside" }, { deliverAs: "aside" }]);
	});

	test("stays inert for a skill without a state schema", async () => {
		const s = fakeOmp([plain]).session("s1");
		await s.invoke("plain");

		expect(s.notices).toEqual([]);
	});

	test("stays inert for an agent-attributed skill-prompt", async () => {
		const s = fakeOmp([procedure]).session("s1");
		await s.invoke("procedure", { attribution: "agent" });

		expect(s.notices).toEqual([]);
	});

	test("stays inert for a model skill read (toolResult message)", async () => {
		const s = fakeOmp([procedure]).session("s1");
		await s.endMessage({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [{ type: "text", text: "skill://procedure/state.schema.json" }],
			isError: false,
			timestamp: Date.now(),
		});

		expect(s.notices).toEqual([]);
	});

	test("stays inert when the skill-prompt details carry no name", async () => {
		const s = fakeOmp([procedure]).session("s1");
		await s.invoke("procedure", { details: {} });

		expect(s.notices).toEqual([]);
	});

	test("stays inert in a subagent session", async () => {
		const s = fakeOmp([procedure]).session("s1", { kind: "sub" });
		await s.invoke("procedure");

		expect(s.notices).toEqual([]);
	});

	test("stays inert when the schema file is not a JSON object", async () => {
		for (const broken of [brokenArray, brokenJson]) {
			const s = fakeOmp([broken]).session("s1");
			await s.invoke(broken.name);

			expect(s.notices).toEqual([]);
		}
	});

	test("ignores a second user invocation while engaged", async () => {
		const { s } = await engaged();
		await s.invoke("procedure");

		expect(s.notices).toEqual(engageNotices("procedure"));
	});

	test("engages once when two invocations arrive before the schema read resolves", async () => {
		const s = fakeOmp([procedure]).session("s1");

		await Promise.all([s.invoke("procedure"), s.invoke("procedure")]);

		expect(s.notices).toEqual(engageNotices("procedure"));
	});

	test("disengages on /new", async () => {
		const { omp, s } = await engaged();

		await s.switchTo(omp.session("s2"), "new");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
	});

	test("disengages on /resume", async () => {
		const { omp, s } = await engaged();

		await s.switchTo(omp.session("s2"), "resume");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/resume")]);
	});

	test("disengages on a fork switch", async () => {
		const { omp, s } = await engaged();

		await s.switchTo(omp.session("s2"), "fork");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "fork")]);
	});

	test("a rewind to before the invocation leaves the runtime inert", async () => {
		const { omp, s } = await engaged();
		// The branched-off session is a different id with an empty branch.
		const fresh = omp.session("s2");

		await s.rewindTo(fresh);

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "branch")]);
		expect(fresh.notices).toEqual([]);
		expect(await fresh.step(patch('{"goal":"x"}'))).toBeUndefined();
		expect(fresh.sends).toEqual([]);
		expect(fresh.storedStates).toEqual([]);
	});

	test("a rewind to after the invocation re-engages with the state as of that point", async () => {
		const { omp, s } = await engaged();
		await s.step(patch('{"goal":"x"}'));
		await s.step(patch('{"goal":"y"}'));
		expect(s.sends.map((sent) => sent.payload.customType)).toEqual([...engageAsideTypes, STATE_MESSAGE_TYPE, STATE_MESSAGE_TYPE]);

		// The new session carries the rewound branch: invocation, head, goal:x.
		const rewound = omp.session("s2", { branch: procedureBranch("procedure", {}, { goal: "x" }) });
		await s.rewindTo(rewound);

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "branch")]);
		expect(rewound.notices).toEqual(engageNotices("procedure"));
		// The re-derive re-sent nothing: the head is already on the branch.
		expect(rewound.sends).toEqual([]);

		await rewound.step(patch('{"extra":1}'));
		expect(rewound.sends.at(-1)?.payload.details).toEqual({ state: { goal: "x", extra: 1 } });
	});

	test("tree navigation re-derives like a rewind", async () => {
		const s = fakeOmp([procedure]).session("s1", { branch: procedureBranch("procedure", {}, { goal: "x" }) });

		await s.tree("l2");

		expect(s.notices).toEqual(engageNotices("procedure"));
		expect(s.sends).toEqual([]);
		await s.step(patch('{"extra":1}'));
		expect(s.sends.at(-1)?.payload.details).toEqual({ state: { goal: "x", extra: 1 } });
	});

	test("/resume of an engaged session re-derives its state and re-engages without resending the head", async () => {
		const { omp, s } = await engaged();
		const target = omp.session("s2", { branch: procedureBranch("procedure", {}, { goal: "x" }) });

		await s.switchTo(target, "resume");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/resume")]);
		expect(target.notices).toEqual(engageNotices("procedure"));
		expect(target.sends).toEqual([]);
		await target.step(patch('{"extra":1}'));
		expect(target.sends.at(-1)?.payload.details).toEqual({ state: { goal: "x", extra: 1 } });
	});

	test("/new starts the next session inert", async () => {
		const { omp, s } = await engaged();
		const fresh = omp.session("s2");

		await s.switchTo(fresh, "new");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
		expect(fresh.notices).toEqual([]);
		expect(await fresh.step(patch('{"goal":"x"}'))).toBeUndefined();
		expect(fresh.sends).toEqual([]);
	});

	test("cold session_start re-engages from the branch without resending the head", async () => {
		const s = fakeOmp([procedure]).session("s1", { branch: procedureBranch("procedure", { goal: "x" }) });

		await s.start();

		expect(s.notices).toEqual(engageNotices("procedure"));
		expect(s.sends).toEqual([]);
		await s.step(patch('{"extra":1}'));
		expect(s.sends.at(-1)?.payload.details).toEqual({ state: { goal: "x", extra: 1 } });
	});

	test("session_start stays inert without a usable procedure on the branch", async () => {
		const empty = fakeOmp([procedure]).session("s1");
		await empty.start();
		expect(empty.notices).toEqual([]);
		expect(await empty.step(patch('{"goal":"x"}'))).toBeUndefined();

		const agent = fakeOmp([procedure]).session("s1", {
			branch: [invocationEntry("procedure", "agent"), specEntry("procedure"), stateEntry({ goal: "x" })],
		});
		await agent.start();
		expect(agent.notices).toEqual([]);

		const schemaless = fakeOmp([plain]).session("s1", { branch: procedureBranch("plain", { goal: "x" }) });
		await schemaless.start();
		expect(schemaless.notices).toEqual([]);
		expect(await schemaless.step(patch('{"goal":"x"}'))).toBeUndefined();

		const sub = fakeOmp([procedure]).session("s1", { kind: "sub", branch: procedureBranch("procedure", { goal: "x" }) });
		await sub.start();
		expect(sub.notices).toEqual([]);

		// Without the stored P there is no head to re-send after a compaction.
		const specless = fakeOmp([procedure]).session("s1", { branch: [invocationEntry("procedure"), stateEntry({ goal: "x" })] });
		await specless.start();
		expect(specless.notices).toEqual([]);
	});

	test("a later invocation re-derives with its own state, never the earlier skill's", async () => {
		const s = fakeOmp([procedure, smallProcedure]).session("s1", {
			branch: [...procedureBranch("procedure", { goal: "old" }), ...procedureBranch("smallcap", { goal: "new" })],
		});

		await s.start();

		expect(s.notices).toEqual(engageNotices("smallcap"));
		await s.step(patch('{"extra":1}'));
		expect(s.sends.at(-1)?.payload.details).toEqual({ state: { goal: "new", extra: 1 } });
	});

	test("an invocation with no state message after it stays inert, even when an earlier procedure left one", async () => {
		const s = fakeOmp([procedure, smallProcedure]).session("s1", {
			branch: [...procedureBranch("procedure", { goal: "old" }), ...procedureBranch("smallcap")],
		});

		await s.start();

		expect(s.notices).toEqual([]);
		expect(await s.step(patch('{"goal":"x"}'))).toBeUndefined();
	});

	test("a fork re-derives like any switch", async () => {
		const { omp, s } = await engaged();
		const fork = omp.session("s2", { branch: procedureBranch("procedure", { goal: "x" }) });

		await s.switchTo(fork, "fork");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "fork")]);
		expect(fork.notices).toEqual(engageNotices("procedure"));
		// The head asides are s1's sends; the fork's re-derive re-sent none.
		expect(fork.sends).toEqual([]);
	});

	test("disengages on tree navigation", async () => {
		const { s } = await engaged();

		// The live branch holds the invocation but no head yet (the asides land at
		// the first step boundary), so the scan finds no procedure to re-derive.
		await s.tree("l2");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "tree navigation")]);
	});

	test("disengages on /clear input, including padded text", async () => {
		const { s } = await engaged();

		await s.input("/clear");
		await s.input("  /clear  ");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/clear")]);
	});

	test("ignores input that is not exactly /clear", async () => {
		const { s } = await engaged();

		await s.input("/clearx");
		await s.input("hello");

		expect(s.notices).toEqual(engageNotices("procedure"));
	});

	test("a repeated trigger after disengage notifies nothing", async () => {
		const { omp, s } = await engaged();
		await s.switchTo(omp.session("s2"), "new");

		await s.switchTo(omp.session("s3"), "new");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
	});

	test("triggers while not engaged notify nothing", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		const other = omp.session("s2");

		await s.switchTo(other, "new");
		await s.switchTo(other, "resume");
		await s.switchTo(other, "fork");
		await s.rewindTo(other);
		await s.tree(null);
		await s.input("/clear");

		expect(s.notices).toEqual([]);
		expect(other.notices).toEqual([]);
	});

	test("engagement in session A is invisible to session B", async () => {
		const omp = fakeOmp([procedure]);
		const a = omp.session("A");
		await a.invoke("procedure");
		const b = omp.session("B");

		await b.tree(null);
		await b.input("/clear");

		expect(b.notices).toEqual([]);
		await a.switchTo(omp.session("C"), "new");
		expect(a.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
	});

	test("sessions A and B engage and disengage independently", async () => {
		const omp = fakeOmp([procedure]);
		const a = omp.session("A");
		const b = omp.session("B");
		await a.invoke("procedure");
		await b.invoke("procedure");

		await b.tree(null);
		expect(b.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "tree navigation")]);
		expect(a.notices).toEqual(engageNotices("procedure"));

		await a.tree(null);
		expect(a.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "tree navigation")]);
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
		const s = fakeOmp([recon]).session("s1");

		await s.invoke("recon");

		expect(s.notices).toEqual(engageNotices("recon"));
	});
});

async function patchHarness(skill: Skill) {
	const { handlers, sent } = harness([skill]);
	const { ctx, notified, setIdle } = await engage(handlers, skill.name);
	// sent starts with the three engage asides (rules, P, initial t); patch tests
	// index past them.
	return { handlers, sent, ctx, notified, setIdle };
}

describe("omp-skill-state patch loop", () => {
	const patch = (json: string) => `\`\`\`json state\n${json}\n\`\`\``;

	// A state message send as the fake records it.
	const stateSend = (state: ExecutionState, deliverAs: "aside" | "nextTurn") => ({ payload: stateMessage(state) as Record<string, unknown>, options: { deliverAs } });

	// An engaged session: the head asides are pending until the first step
	// boundary, which is where the recorded pi left every patch test too.
	async function engaged(skill: Skill = procedure) {
		const omp = fakeOmp([skill]);
		const s = omp.session("s1");
		await s.invoke(skill.name);
		return { omp, s };
	}

	test("the renderer shows keys collapsed and pretty JSON expanded, never the raw one-liner", () => {
		const renderer = fakeOmp([procedure]).renderers.get(STATE_MESSAGE_TYPE) as
			| ((message: unknown, options: { expanded: boolean }, theme: unknown) => { getText(): string })
			| undefined;
		expect(renderer).toBeDefined();
		const theme = { fg: (_color: string, text: string) => text };
		const render = (expanded: boolean, state: ExecutionState) =>
			renderer!({ role: "custom", customType: STATE_MESSAGE_TYPE, content: renderStateContent(state), display: true, details: { state }, timestamp: Date.now() }, { expanded }, theme).getText();

		const collapsed = render(false, { goal: "g" });
		expect(collapsed).toContain("goal");
		expect(collapsed).not.toContain('{"goal":"g"}');

		const expanded = render(true, { goal: "g" });
		expect(expanded).toContain('"goal": "g"');
	});

	test("no patch block is an empty patch: nothing sent, tool calls run", async () => {
		const { s } = await engaged();

		await s.step("Prose only, calling a tool.");

		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);
		expect(s.blocked).toEqual([]);
	});

	test("a valid patch is merged and sent as a state message, aside", async () => {
		const { s } = await engaged();

		await s.step(patch('{"goal":"x"}'));

		expect(s.sends).toHaveLength(4);
		expect(s.sends[3]).toEqual(stateSend({ goal: "x" }, "aside"));
		expect(s.blocked).toEqual([]);
		// Stored at the step boundary, before the next provider call.
		expect(s.storedStates).toEqual([{}, { goal: "x" }]);
	});

	test("a second valid patch merges into the first instead of replacing it", async () => {
		const { s } = await engaged();

		await s.step(patch('{"goal":"x"}'));
		await s.step(patch('{"extra": 1}'));

		expect(s.sends).toHaveLength(5);
		expect(s.sends[4]!.payload.details).toEqual({ state: { goal: "x", extra: 1 } });
		expect(s.storedStates.at(-1)).toEqual({ goal: "x", extra: 1 });
	});

	test("a patch in a step with no tool call is stored as a next-turn message once the session is idle after agent_end", async () => {
		const { s } = await engaged();
		jest.useFakeTimers();
		try {
			await s.step(patch('{"goal":"x"}'), { tools: [] });
			// agent_end fired inside the run: nothing is sent yet, because the
			// harness would only hold the message until the next prompt.
			expect(s.sends).toHaveLength(3);
			jest.advanceTimersByTime(100);
			expect(s.sends).toHaveLength(3);

			s.setIdle(true);
			jest.advanceTimersByTime(20);
			expect(s.sends).toHaveLength(4);
			expect(s.sends[3]).toEqual(stateSend({ goal: "x" }, "nextTurn"));
			// Idle delivery lands on the branch at once, without a turn.
			expect(s.storedStates.at(-1)).toEqual({ goal: "x" });

			// Stored once: a later run end has nothing pending.
			await s.step("done", { tools: [] });
			jest.advanceTimersByTime(100);
			expect(s.sends).toHaveLength(4);

			// The live state advanced at the patch, not at the store.
			await s.step(patch('{"extra":1}'));
			expect(s.sends).toHaveLength(5);
			expect(s.sends[4]).toEqual(stateSend({ goal: "x", extra: 1 }, "aside"));
		} finally {
			jest.useRealTimers();
		}
	});

	test("a final state superseded by a later patch before the session is idle is dropped, not stored stale", async () => {
		const { s } = await engaged();
		jest.useFakeTimers();
		try {
			await s.step(patch('{"goal":"x"}'), { tools: [] });
			// A queued prompt ran another step before the session went idle.
			await s.step(patch('{"goal":"y"}'));
			expect(s.sends).toHaveLength(4);
			expect(s.sends[3]!.payload.details).toEqual({ state: { goal: "y" } });

			s.setIdle(true);
			jest.advanceTimersByTime(5000);
			expect(s.sends).toHaveLength(4);
		} finally {
			jest.useRealTimers();
		}
	});

	test("a session that never goes idle still gets the final state after the poll budget, held by the harness for the next prompt", async () => {
		const { s } = await engaged();
		jest.useFakeTimers();
		try {
			await s.step(patch('{"goal":"x"}'), { tools: [] });
			jest.advanceTimersByTime(1900);
			expect(s.sends).toHaveLength(3);
			jest.advanceTimersByTime(200);
			expect(s.sends).toHaveLength(4);
			expect(s.sends[3]!.options).toEqual({ deliverAs: "nextTurn" });
			// Sent while busy: held to the next step boundary, not on the branch yet.
			expect(s.storedStates).toEqual([{}]);
		} finally {
			jest.useRealTimers();
		}
	});

	test("an invalid patch blocks every tool call with the validation error and sends nothing", async () => {
		const { s } = await engaged();

		await s.step(patch('{"goal": 42}'), { tools: ["read", "bash"] });

		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);
		expect(s.blocked.map((call) => call.toolName)).toEqual(["read", "bash"]);
		for (const call of s.blocked) expect(call.reason).toContain("goal");
	});

	test("malformed JSON blocks with the parse error", async () => {
		const { s } = await engaged();

		await s.step("```json state\n{ nope\n```");

		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);
		expect(s.blocked).toHaveLength(1);
		expect(s.blocked[0]!.reason).toContain("valid JSON");
	});

	test("a valid retry recovers and the session stays engaged", async () => {
		const { omp, s } = await engaged();

		await s.step(patch('{"goal": 42}'));
		await s.step(patch('{"goal":"x"}'));

		// Only the failed step's call was blocked; the retry's call ran.
		expect(s.blocked).toHaveLength(1);
		expect(s.sends).toHaveLength(4); // engage asides plus the recovered state message

		await s.switchTo(omp.session("s2"), "new");
		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
	});

	test("the third consecutive invalid patch degrades and the session runs ordinarily", async () => {
		const { omp, s } = await engaged();

		for (let i = 0; i < 3; i++) await s.step(patch('{"goal": 42}'));

		expect(s.notices).toEqual([
			...engageNotices("procedure"),
			{ message: 'skill-state: procedure "procedure" degraded after 3 invalid patches; running ordinarily', type: "warning" },
		]);
		// The degrading step runs its tools as an ordinary step would: only the
		// first two steps were blocked.
		expect(s.blocked).toHaveLength(2);

		await s.step(patch('{"goal": 42}'));
		expect(s.blocked).toHaveLength(2);
		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);

		await s.switchTo(omp.session("s2"), "new");
		expect(s.notices).toEqual([
			...engageNotices("procedure"),
			{ message: 'skill-state: procedure "procedure" degraded after 3 invalid patches; running ordinarily', type: "warning" },
		]);
	});

	test("the degrade threshold honours x-state retries", async () => {
		const { s } = await engaged(retryProcedure);

		await s.step(patch('{"goal": 42}'));
		expect(s.notices).toEqual(engageNotices("retryproc"));

		await s.step(patch('{"goal": 42}'));
		expect(s.notices).toEqual([
			...engageNotices("retryproc"),
			{ message: 'skill-state: procedure "retryproc" degraded after 2 invalid patches; running ordinarily', type: "warning" },
		]);
	});

	test("a valid patch between failures resets the consecutive counter", async () => {
		const { omp, s } = await engaged();

		await s.step(patch('{"goal": 42}'));
		await s.step(patch('{"goal": 42}'));
		await s.step(patch('{"goal":"x"}'));
		await s.step(patch('{"goal": 42}'));
		await s.step(patch('{"goal": 42}'));
		expect(s.notices).toEqual(engageNotices("procedure"));

		await s.switchTo(omp.session("s2"), "new");
		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
	});

	test("assistant_message and tool_call are inert when not engaged and in a subagent", async () => {
		const omp = fakeOmp([procedure]);

		const main = omp.session("s1");
		await main.step(patch('{"goal":"x"}'));
		expect(main.sends).toEqual([]);
		expect(main.blocked).toEqual([]);
		expect(main.notices).toEqual([]);

		const sub = omp.session("s2", { kind: "sub" });
		await sub.step(patch('{"goal":"x"}'));
		expect(sub.sends).toEqual([]);
		expect(sub.blocked).toEqual([]);
		expect(sub.notices).toEqual([]);
	});
});

describe("omp-skill-state idle disengage", () => {
	// A projected step: the provider call sees the head, built from the asides
	// sent so far, then the model answers.
	async function step(handlers: Map<string, Handler>, sent: Sent[], ctx: ExtensionContext, text: string) {
		const head = sent.map((s) => ({ role: "custom", ...s.payload }));
		await handler(handlers, "context")({ type: "context", messages: head }, ctx);
		await handler(handlers, "assistant_message")(assistantMessage(text), ctx);
	}

	test("three consecutive no-patch steps disengage; two stay engaged", async () => {
		const { handlers, sent, ctx, notified } = await patchHarness(procedure);

		await step(handlers, sent, ctx, "step 1");
		await step(handlers, sent, ctx, "step 2");
		expect(notified).toEqual(engageNotices("procedure"));

		await step(handlers, sent, ctx, "step 3");
		expect(notified).toEqual([
			...engageNotices("procedure"),
			{ message: 'skill-state: procedure "procedure" disengaged (idle for 3 steps)', type: "info" },
		]);
	});

	test("the idle threshold honours x-state idleSteps", async () => {
		const { handlers, sent, ctx, notified } = await patchHarness(idleProcedure);

		await step(handlers, sent, ctx, "step 1");
		expect(notified).toEqual(engageNotices("idleproc"));

		await step(handlers, sent, ctx, "step 2");
		expect(notified).toEqual([
			...engageNotices("idleproc"),
			{ message: 'skill-state: procedure "idleproc" disengaged (idle for 2 steps)', type: "info" },
		]);
	});

	test("a step whose prompt carried no head is not an idle step", async () => {
		const { handlers, sent, ctx, notified } = await patchHarness(idleProcedure);

		// The engage asides land after the first provider call; that step never
		// saw the rules, so the model cannot be idle in it.
		await handler(handlers, "assistant_message")(assistantMessage("step 1"), ctx);
		await step(handlers, sent, ctx, "step 2");
		expect(notified).toEqual(engageNotices("idleproc"));

		await step(handlers, sent, ctx, "step 3");
		expect(notified).toEqual([...engageNotices("idleproc"), ...disengageNotices("idleproc", "idle for 2 steps")]);
	});

	test("a patch that leaves the state unchanged is an empty patch: nothing stored, and the step is idle", async () => {
		const { handlers, sent, ctx, notified } = await patchHarness(idleProcedure);

		await step(handlers, sent, ctx, '```json state\n{"goal":"x"}\n```');
		expect(sent).toHaveLength(4);

		await step(handlers, sent, ctx, '```json state\n{"goal":"x"}\n```');
		expect(sent).toHaveLength(4);
		expect(notified).toEqual(engageNotices("idleproc"));

		await step(handlers, sent, ctx, '```json state\n{"goal":"x"}\n```');
		expect(sent).toHaveLength(4);
		expect(notified).toEqual([...engageNotices("idleproc"), ...disengageNotices("idleproc", "idle for 2 steps")]);
	});

	test("a valid patch between idle steps resets the idle run", async () => {
		const { handlers, sent, ctx, notified } = await patchHarness(procedure);

		await step(handlers, sent, ctx, "no patch");
		await step(handlers, sent, ctx, "no patch");
		await step(handlers, sent, ctx, '```json state\n{"goal":"x"}\n```');
		await step(handlers, sent, ctx, "no patch");
		await step(handlers, sent, ctx, "no patch");

		expect(notified).toEqual(engageNotices("procedure"));
	});

	test("an invalid patch also resets the idle run", async () => {
		const { handlers, sent, ctx, notified } = await patchHarness(procedure);

		await step(handlers, sent, ctx, "no patch");
		await step(handlers, sent, ctx, "no patch");
		await step(handlers, sent, ctx, '```json state\n{"goal": 42}\n```');
		await step(handlers, sent, ctx, "no patch");
		await step(handlers, sent, ctx, "no patch");

		expect(notified).toEqual(engageNotices("procedure"));
	});

	test("after an idle disengage the step is ordinary", async () => {
		const { handlers, sent, ctx, notified } = await patchHarness(idleProcedure);

		await step(handlers, sent, ctx, "step 1");
		await step(handlers, sent, ctx, "step 2");
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
		branchEntries: unknown[] = [],
	): Promise<CompactionOutput | undefined> {
		const result = await handler(handlers, "session_before_compact")(
			{ type: "session_before_compact", preparation, signal: new AbortController().signal, branchEntries },
			ctx,
		);
		return result as CompactionOutput | undefined;
	}

	// A branch mid-step: the latest assistant message is the step's pinned
	// message, and its tool result sits after it, so a cut there keeps the pair.
	const midStepBranch = [
		{ type: "custom_message", id: "h1", customType: RULES_MESSAGE_TYPE },
		{ type: "message", id: "a1", message: { role: "assistant" } },
		{ type: "message", id: "r1", message: { role: "toolResult" } },
		{ type: "custom_message", id: "s1", customType: STATE_MESSAGE_TYPE },
		{ type: "message", id: "a2", message: { role: "assistant" } },
		{ type: "custom", id: "x1", customType: "tool_execution_start" },
		{ type: "message", id: "r2", message: { role: "toolResult" } },
	];

	test("registers session_before_compact lazily on the first engage, never at load", async () => {
		const { handlers } = harness([procedure]);
		expect(handlers.has("session_before_compact")).toBe(false);

		await engage(handlers, "procedure");

		expect(handlers.has("session_before_compact")).toBe(true);
	});

	test("engaged compaction summarises to the state and cuts at the current step, not at the harness's turn-sized tail", async () => {
		const { handlers, sent } = harness([procedure]);
		const { ctx } = await engage(handlers, "procedure");
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"g"}\n```'), ctx);

		const result = await compact(handlers, ctx, { firstKeptEntryId: "h1", tokensBefore: 4321 }, midStepBranch);

		const compaction = result?.compaction;
		expect(compaction?.firstKeptEntryId).toBe("a2");
		expect(compaction?.tokensBefore).toBe(4321);
		expect(compaction?.summary).toContain('Execution state of procedure "procedure"');
		expect(compaction?.summary).toContain(JSON.stringify({ goal: "g" }, null, 2));
		expect(compaction?.shortSummary).toContain('"procedure"');
		expect(compaction?.preserveData).toEqual({ state: { goal: "g" } });
		// No summarizer step: compaction adds no sends beyond the patch loop's own.
		expect(sent.map((s) => s.payload.customType)).toEqual([...engageAsideTypes, STATE_MESSAGE_TYPE]);
	});

	test("a branch with no assistant message yet falls back to the harness's cut", async () => {
		const { handlers } = harness([procedure]);
		const { ctx } = await engage(handlers, "procedure");

		const result = await compact(handlers, ctx, { firstKeptEntryId: "e7", tokensBefore: 10 }, [midStepBranch[0]]);

		expect(result?.compaction?.firstKeptEntryId).toBe("e7");
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

	test("after a compaction the head is sent again, byte-equal, so the projection survives the cut", async () => {
		const { handlers, sent } = harness([procedure]);
		const { ctx } = await engage(handlers, "procedure");
		await handler(handlers, "assistant_message")(assistantMessage('```json state\n{"goal":"g"}\n```'), ctx);

		await handler(handlers, "session_compact")({ type: "session_compact", compactionEntry: {}, fromExtension: true }, ctx);

		expect(sent.map((s) => s.payload.customType)).toEqual([...engageAsideTypes, STATE_MESSAGE_TYPE, ...engageAsideTypes]);
		expect(sent.slice(4).map((s) => s.payload)).toEqual([sent[0].payload, sent[1].payload, sent[3].payload]);
		// Mid-run: asides, so the copies land before the next provider call.
		expect(sent.slice(4).map((s) => s.options)).toEqual([{ deliverAs: "aside" }, { deliverAs: "aside" }, { deliverAs: "aside" }]);

		// The copies alone are a complete head.
		const kept = sent.slice(4).map((s) => ({ role: "custom", ...s.payload }));
		expect(await handler(handlers, "context")({ type: "context", messages: kept }, ctx)).toEqual({ messages: kept });
	});

	test("a compaction while idle re-sends the head as next-turn messages, which wake no turn", async () => {
		const { handlers, sent } = harness([procedure]);
		const { ctx } = mockCtx("s1", "main", [], true);
		await handler(handlers, "message_end")({ type: "message_end", message: skillPrompt("procedure") }, ctx);

		await handler(handlers, "session_compact")({ type: "session_compact", compactionEntry: {}, fromExtension: true }, ctx);

		expect(sent).toHaveLength(6);
		expect(sent.slice(3).map((s) => s.options)).toEqual([{ deliverAs: "nextTurn" }, { deliverAs: "nextTurn" }, { deliverAs: "nextTurn" }]);
	});

	test("a re-derived engagement re-heads with the P and state stored on the branch", async () => {
		const { handlers, sent } = harness([procedure]);
		const { ctx } = mockCtx("s1", "main", procedureBranch("procedure", {}, { goal: "x" }));
		await handler(handlers, "session_start")({ type: "session_start" }, ctx);

		await handler(handlers, "session_compact")({ type: "session_compact", compactionEntry: {}, fromExtension: true }, ctx);

		expect(sent.map((s) => s.payload)).toEqual([
			{ customType: RULES_MESSAGE_TYPE, content: OPERATING_RULES, display: false },
			{ customType: PROCEDURE_SPEC_MESSAGE_TYPE, content: "Running skill procedure", display: false, details: { name: "procedure" } },
			{ customType: STATE_MESSAGE_TYPE, content: renderStateContent({ goal: "x" }), display: true, details: { state: { goal: "x" } } },
		]);
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
