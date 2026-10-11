import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionEntry, Skill } from "@oh-my-pi/pi-coding-agent";
import { fakeOmp, invocationEntry, procedureBranch, specEntry, stateEntry } from "./fake-session";
import { RULES_MESSAGE_TYPE, PROCEDURE_SPEC_MESSAGE_TYPE, STATE_MESSAGE_TYPE, renderStateContent, stateMessage } from "./messages";
import { OPERATING_RULES } from "./patch";
import type { ExecutionState } from "./state";
import { makeSkill } from "./skill-fixtures";

// Engage sends exactly these three asides; the patch loop must add nothing else.
const engageAsideTypes = [RULES_MESSAGE_TYPE, PROCEDURE_SPEC_MESSAGE_TYPE, STATE_MESSAGE_TYPE];

const engageNotices = (name: string) => [
	{ message: `skill-state: procedure "${name}" engaged`, type: "info" },
	{ message: "skill-state: history is hidden from the model while engaged; finish with /new", type: "info" },
];
const disengageNotices = (name: string, trigger: string) => [
	{ message: `skill-state: procedure "${name}" disengaged (${trigger})`, type: "info" },
];

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

	test("the bundled zstate skill engages end to end", async () => {
		const baseDir = path.join(import.meta.dir, "skills", "zstate");
		const zstate: Skill = {
			name: "zstate",
			description: "bundled sample procedure skill",
			filePath: path.join(baseDir, "SKILL.md"),
			baseDir,
			source: "test",
		};
		const s = fakeOmp([zstate]).session("s1");

		await s.invoke("zstate");

		expect(s.notices).toEqual(engageNotices("zstate"));
	});
});

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
	const patch = (json: string) => `\`\`\`json state\n${json}\n\`\`\``;

	// The first step after engage runs before the head asides land, so its
	// prompt is not projected and it never counts as idle (spec section 11.4).
	// Every step after it carries the head.
	async function projecting(skill: Skill = procedure) {
		const omp = fakeOmp([skill]);
		const s = omp.session("s1");
		await s.invoke(skill.name);
		expect(await s.step("the first step lands the head")).toBeUndefined();
		return { omp, s };
	}

	test("three consecutive no-patch steps disengage; two stay engaged", async () => {
		const { s } = await projecting();

		expect(await s.step("step 1")).toBeDefined();
		await s.step("step 2");
		expect(s.notices).toEqual(engageNotices("procedure"));

		await s.step("step 3");
		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "idle for 3 steps")]);
	});

	test("the idle threshold honours x-state idleSteps", async () => {
		const { s } = await projecting(idleProcedure);

		await s.step("step 1");
		expect(s.notices).toEqual(engageNotices("idleproc"));

		await s.step("step 2");
		expect(s.notices).toEqual([...engageNotices("idleproc"), ...disengageNotices("idleproc", "idle for 2 steps")]);
	});

	test("a step whose prompt carried no head is not an idle step", async () => {
		const s = fakeOmp([idleProcedure]).session("s1");
		await s.invoke("idleproc");

		// The engage asides land at the first step boundary; that step never saw
		// the rules, so the model cannot be idle in it.
		expect(await s.step("step 1")).toBeUndefined();
		expect(await s.step("step 2")).toBeDefined();
		expect(s.notices).toEqual(engageNotices("idleproc"));

		await s.step("step 3");
		expect(s.notices).toEqual([...engageNotices("idleproc"), ...disengageNotices("idleproc", "idle for 2 steps")]);
	});

	test("a patch that leaves the state unchanged is an empty patch: nothing stored, and the step is idle", async () => {
		const { s } = await projecting(idleProcedure);

		await s.step(patch('{"goal":"x"}'));
		expect(s.sends).toHaveLength(4);

		await s.step(patch('{"goal":"x"}'));
		expect(s.sends).toHaveLength(4);
		expect(s.notices).toEqual(engageNotices("idleproc"));

		await s.step(patch('{"goal":"x"}'));
		expect(s.sends).toHaveLength(4);
		expect(s.storedStates).toEqual([{}, { goal: "x" }]);
		expect(s.notices).toEqual([...engageNotices("idleproc"), ...disengageNotices("idleproc", "idle for 2 steps")]);
	});

	test("a valid patch between idle steps resets the idle run", async () => {
		const { s } = await projecting();

		await s.step("no patch");
		await s.step("no patch");
		await s.step(patch('{"goal":"x"}'));
		await s.step("no patch");
		await s.step("no patch");

		expect(s.notices).toEqual(engageNotices("procedure"));
	});

	test("an invalid patch also resets the idle run", async () => {
		const { s } = await projecting();

		await s.step("no patch");
		await s.step("no patch");
		await s.step(patch('{"goal": 42}'));
		await s.step("no patch");
		await s.step("no patch");

		expect(s.blocked).toHaveLength(1);
		expect(s.notices).toEqual(engageNotices("procedure"));
	});

	test("after an idle disengage the step is ordinary", async () => {
		const { s } = await projecting(idleProcedure);

		await s.step("step 1");
		await s.step("step 2");
		expect(s.notices).toEqual([...engageNotices("idleproc"), ...disengageNotices("idleproc", "idle for 2 steps")]);

		await s.step(patch('{"goal":"x"}'));
		expect(s.blocked).toEqual([]);
		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);
	});
});

describe("omp-skill-state compaction ownership", () => {
	const patch = (json: string) => `\`\`\`json state\n${json}\n\`\`\``;

	test("registers session_before_compact lazily on the first engage, never at load", async () => {
		const omp = fakeOmp([procedure]);
		expect(omp.registered("session_before_compact")).toBe(false);

		await omp.session("s1").invoke("procedure");

		expect(omp.registered("session_before_compact")).toBe(true);
	});

	test("engaged compaction summarises to the state and cuts at the current step, not at the harness's turn-sized tail", async () => {
		const omp = fakeOmp([procedure]);
		// The branch already holds an earlier step, so the harness's proposed cut
		// and that earlier assistant message must both lose to the current step.
		const earlier = [
			{ type: "custom_message", id: "h1", customType: RULES_MESSAGE_TYPE },
			{ type: "message", id: "a1", message: { role: "assistant" } },
			{ type: "message", id: "r1", message: { role: "toolResult" } },
		] as unknown as SessionEntry[];
		const s = omp.session("s1", { branch: earlier });
		await s.invoke("procedure");
		await s.step(patch('{"goal":"g"}'));

		const pinned = s.branch.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").at(-1)!;
		const result = await s.compact({ firstKeptEntryId: "h1", tokensBefore: 4321 });

		const compaction = result?.compaction;
		expect(compaction?.firstKeptEntryId).toBe(pinned.id);
		expect(compaction?.firstKeptEntryId).not.toBe("a1");
		expect(compaction?.tokensBefore).toBe(4321);
		expect(compaction?.summary).toContain('Execution state of procedure "procedure"');
		expect(compaction?.summary).toContain(JSON.stringify({ goal: "g" }, null, 2));
		expect(compaction?.shortSummary).toContain('"procedure"');
		expect(compaction?.preserveData).toEqual({ state: { goal: "g" } });
		// No summarizer step: session_before_compact itself sends nothing; the
		// three sends after the patch loop's are session_compact's head re-send.
		expect(s.sends.map((sent) => sent.payload.customType)).toEqual([...engageAsideTypes, STATE_MESSAGE_TYPE, ...engageAsideTypes]);
	});

	test("a branch with no assistant message yet falls back to the harness's cut", async () => {
		const omp = fakeOmp([procedure]);
		const seed = [{ type: "custom_message", id: "h1", customType: RULES_MESSAGE_TYPE }] as unknown as SessionEntry[];
		const s = omp.session("s1", { branch: seed });
		await s.invoke("procedure");

		const result = await s.compact({ firstKeptEntryId: "e7", tokensBefore: 10 });

		expect(result?.compaction?.firstKeptEntryId).toBe("e7");
	});

	test("a second compaction carries the live state, not an echo of previousPreserveData", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		await s.invoke("procedure");
		await s.step(patch('{"goal":"g"}'));

		const first = await s.compact({ firstKeptEntryId: "e7", tokensBefore: 4321 });
		await s.step(patch('{"step":2}'));
		const second = await s.compact({ firstKeptEntryId: "e9", tokensBefore: 5000, previousPreserveData: first?.compaction?.preserveData });

		expect(first?.compaction?.preserveData).toEqual({ state: { goal: "g" } });
		expect(second?.compaction?.tokensBefore).toBe(5000);
		expect(second?.compaction?.preserveData).toEqual({ state: { goal: "g", step: 2 } });
	});

	test("after a compaction the head is sent again, byte-equal, so the projection survives the cut", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		await s.invoke("procedure");
		await s.step(patch('{"goal":"g"}'));

		await s.compact();

		expect(s.sends.map((sent) => sent.payload.customType)).toEqual([...engageAsideTypes, STATE_MESSAGE_TYPE, ...engageAsideTypes]);
		expect(s.sends.slice(4).map((sent) => sent.payload)).toEqual([s.sends[0]!.payload, s.sends[1]!.payload, s.sends[3]!.payload]);
		// Mid-run: asides, so the copies land before the next provider call.
		expect(s.sends.slice(4).map((sent) => sent.options)).toEqual([{ deliverAs: "aside" }, { deliverAs: "aside" }, { deliverAs: "aside" }]);

		// The cut kept the pre-compaction head, so the step right after the
		// compaction still projects, pinning the step before as its observation.
		const projected = await s.step("continue");
		expect(projected?.slice(0, 3).map((message) => (message as { customType?: string }).customType)).toEqual(engageAsideTypes);
		expect(projected?.[0] as Record<string, unknown>).toMatchObject(s.sends[0]!.payload);
		expect(projected?.[1] as Record<string, unknown>).toMatchObject(s.sends[1]!.payload);
		expect(projected?.[2] as Record<string, unknown>).toMatchObject(s.sends[3]!.payload);
		expect(projected?.slice(3)).toHaveLength(2);

		// The copies flushed at that step boundary, so the next provider call
		// carries them: the head is complete again after the cut.
		const after = await s.step("done", { tools: [] });
		expect(after?.[0] as Record<string, unknown>).toMatchObject(s.sends[4]!.payload);
		expect(after?.[1] as Record<string, unknown>).toMatchObject(s.sends[5]!.payload);
		expect(after?.[2] as Record<string, unknown>).toMatchObject(s.sends[6]!.payload);
		expect(after?.slice(3)).toHaveLength(2);
	});

	test("a compaction while idle re-sends the head as next-turn messages, which wake no turn", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		s.setIdle(true);
		await s.invoke("procedure");

		await s.compact();

		expect(s.sends).toHaveLength(6);
		expect(s.sends.slice(3).map((sent) => sent.options)).toEqual([{ deliverAs: "nextTurn" }, { deliverAs: "nextTurn" }, { deliverAs: "nextTurn" }]);
	});

	test("a re-derived engagement re-heads with the P and state stored on the branch", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1", { branch: procedureBranch("procedure", {}, { goal: "x" }) });
		await s.start();

		await s.compact();

		expect(s.sends.map((sent) => sent.payload)).toEqual([
			{ customType: RULES_MESSAGE_TYPE, content: OPERATING_RULES, display: false },
			{ customType: PROCEDURE_SPEC_MESSAGE_TYPE, content: "Running skill procedure", display: false, details: { name: "procedure" } },
			{ customType: STATE_MESSAGE_TYPE, content: renderStateContent({ goal: "x" }), display: true, details: { state: { goal: "x" } } },
		]);
	});

	test("yields to the harness default when never engaged, in a subagent, or after disengage", async () => {
		const omp = fakeOmp([procedure]);
		// Engaging s2 registers the process-wide handler; s1 has never engaged.
		await omp.session("s2").invoke("procedure");
		const never = omp.session("s1");
		expect(await never.compact({ firstKeptEntryId: "e1", tokensBefore: 1 })).toBeUndefined();

		const sub = omp.session("s3", { kind: "sub" });
		await sub.invoke("procedure");
		expect(await sub.compact({ firstKeptEntryId: "e2", tokensBefore: 2 })).toBeUndefined();

		const s = omp.session("s4");
		await s.invoke("procedure");
		await s.switchTo(omp.session("s5"), "new");
		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
		expect(await s.compact({ firstKeptEntryId: "e3", tokensBefore: 3 })).toBeUndefined();
	});
});

describe("omp-skill-state projection (context seam)", () => {
	test("returns undefined for a subagent session and when not engaged", async () => {
		const omp = fakeOmp([procedure]);
		expect(await omp.session("s1").step("ordinary")).toBeUndefined();

		const sub = omp.session("s2", { kind: "sub" });
		await sub.invoke("procedure");
		expect(await sub.step("ordinary")).toBeUndefined();
	});

	test("engaged: projects head plus the current step and honours x-state observationBytes", async () => {
		const omp = fakeOmp([smallProcedure]);
		const s = omp.session("s1");
		await s.invoke("smallcap");
		// The first step runs before the engage asides land; from the second one
		// the projection pins the step before as the observation.
		await s.step("warm-up");
		await s.step("working", { results: ["y".repeat(1000)] });

		const prompt = await s.step("done", { tools: [] });
		const input = s.lastContextMessages!;

		expect(prompt).toHaveLength(5);
		// The head and the pinned call are the stored objects themselves: byte
		// equality with history is what anchors the provider cache prefix.
		expect(prompt?.[0]).toBe(input[3]);
		expect(prompt?.[1]).toBe(input[4]);
		expect(prompt?.[2]).toBe(input[5]);
		expect(prompt?.[3]).toBe(input[6]);
		const capped = prompt?.[4] as { content: Array<{ type: string; text?: string }>; toolCallId: string };
		expect(capped.toolCallId).toBe((input[7] as { toolCallId: string }).toolCallId);
		const total = capped.content.reduce(
			(sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text ?? "") : 0),
			0,
		);
		expect(total).toBeLessThanOrEqual(300);
		expect(capped.content.at(-1)?.text).toContain("observation cap 300 bytes exceeded");
	});

	test("engaged: a user turn projects head plus the user message", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		await s.invoke("procedure");
		await s.step("warm-up");

		const prompt = await s.userTurn("go on");

		expect(prompt).toHaveLength(4);
		expect(prompt?.[0]).toBe(s.lastContextMessages?.[3]);
		expect(prompt?.[3]).toBe(s.lastContextMessages?.at(-1));
	});

	test("the projection never mutates the stored transcript, even when it truncates", async () => {
		const omp = fakeOmp([smallProcedure]);
		const s = omp.session("s1");
		await s.invoke("smallcap");
		await s.step("warm-up");
		await s.step("working", { results: ["y".repeat(1000)] });

		const stored = s.branch.filter((entry) => entry.type === "message").at(-1)!;
		const message = stored.message as { content: unknown[] };
		const snapshot = structuredClone(message.content);
		const prompt = await s.step("done", { tools: [] });

		expect(message.content).toEqual(snapshot);
		expect(prompt?.[4]).not.toBe(message);
	});
});
