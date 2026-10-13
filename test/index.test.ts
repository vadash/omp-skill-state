import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionEntry, Skill } from "@oh-my-pi/pi-coding-agent";
import { fakeOmp, coreStateEntry, invocationEntry, procedureBranch, scratchStateEntry, specEntry, stateEntries } from "./fake-session";
import { OPERATING_RULES, RULES_MESSAGE_TYPE, PROCEDURE_SPEC_MESSAGE_TYPE, STATE_UPDATE_TOOL_NAME, STATE_UPDATE_DESCRIPTION, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE, renderStateContent, coreMessage, scratchMessage } from "../src/messages";
import type { ExecutionState, StateSchema } from "../src/state";
import { loadStateSchema, splitState } from "../src/state";
import { makeSkill } from "./skill-fixtures";

// Engage sends exactly these four asides; the patch loop must add nothing else.
const engageAsideTypes = [RULES_MESSAGE_TYPE, PROCEDURE_SPEC_MESSAGE_TYPE, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE];

// The `procedure` skill's schema declares only `goal`, so `goal` lands
// in the state core and every other key in the scratch state.
const procedureSchema: StateSchema = { type: "object", properties: { goal: { type: "string" } } };

// The two stored state messages a commit sends, in order, as the fake records
// them.
const stateSends = (state: ExecutionState, deliverAs: "aside" | "nextTurn") => {
	const { core, scratch } = splitState(state, procedureSchema);
	return [
		{ payload: coreMessage(core) as Record<string, unknown>, options: { deliverAs } },
		{ payload: scratchMessage(scratch) as Record<string, unknown>, options: { deliverAs } },
	];
};

// The step options for a reply whose batch calls state_update with a patch,
// optionally alongside extra tools.
const patchStep = (patch: unknown, extraTools: string[] = []) => ({
	tools: [STATE_UPDATE_TOOL_NAME, ...extraTools],
	arguments: [{ patch }, ...extraTools.map(() => ({}))],
});

// The developer messages a returned prompt carries; the per-call nudges are
// the consolidation ask and the idle warning.
function nudgeIn(prompt: unknown[] | undefined): { role: unknown; content: unknown }[] {
	const nudges: { role: unknown; content: unknown }[] = [];
	for (const message of prompt ?? []) {
		if (typeof message === "object" && message !== null && "role" in message && "content" in message && message.role === "developer") {
			nudges.push(message);
		}
	}
	return nudges;
}

// Narrows an unknown context message to the custom head messages; the fake's
// branch messages are untyped at this seam.
const isCustomMessage = (message: unknown): message is { role: "custom"; customType: string; content: unknown } =>
	typeof message === "object" && message !== null && "role" in message && message.role === "custom";

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
let windowProcedure: Skill;
let idleProcedure: Skill;
let warnProcedure: Skill;
let capProcedure: Skill;

beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), "omp-skill-state-"));
	procedure = await makeSkill(root, "procedure", JSON.stringify(procedureSchema));
	smallProcedure = await makeSkill(
		root,
		"smallcap",
		JSON.stringify({ type: "object", properties: { goal: { type: "string" } }, "x-state": { observationBytes: 300 } }),
	);
	// The bundled zstate schema, loaded from the repo so a change to its
	// x-state window flows into this suite.
	windowProcedure = await makeSkill(
		root,
		"zstate",
		await readFile(path.join(import.meta.dir, "..", "skills", "zstate", "state.schema.json"), "utf8"),
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
	warnProcedure = await makeSkill(
		root,
		"warnproc",
		JSON.stringify({ type: "object", properties: { goal: { type: "string" } }, "x-state": { idleSteps: 3 } }),
	);
	capProcedure = await makeSkill(
		root,
		"capproc",
		JSON.stringify({ type: "object", properties: { goal: { type: "string" } }, "x-state": { stateBytes: 300 } }),
	);
	plain = await makeSkill(root, "plain");
	brokenArray = await makeSkill(root, "brokenarray", "[]");
	brokenJson = await makeSkill(root, "brokenjson", "{ not json");
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("omp-skill-state engage/disengage lifecycle", () => {
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

	test("engage sends the rules, the procedure spec and the initial state core and scratch as four asides", async () => {
		const { s } = await engaged();

		expect(s.sends.map((sent) => sent.payload)).toEqual([
			{ customType: RULES_MESSAGE_TYPE, content: OPERATING_RULES, display: false },
			{ customType: PROCEDURE_SPEC_MESSAGE_TYPE, content: "Running skill procedure", display: false, details: { name: "procedure" } },
			{ customType: STATE_CORE_MESSAGE_TYPE, content: renderStateContent({}), display: true, details: { state: {} } },
			{ customType: STATE_SCRATCH_MESSAGE_TYPE, content: renderStateContent({}), display: true, details: { state: {} } },
		]);
		expect(s.sends.map((sent) => sent.options)).toEqual([
			{ deliverAs: "aside" },
			{ deliverAs: "aside" },
			{ deliverAs: "aside" },
			{ deliverAs: "aside" },
		]);
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
		expect(await fresh.step("recording", patchStep({ goal: "x" }))).toBeUndefined();
		expect(fresh.sends).toEqual([]);
		expect(fresh.storedStates).toEqual([]);
	});

	test("a rewind to after the invocation re-engages with the state as of that point", async () => {
		const { omp, s } = await engaged();
		await s.step("recording", patchStep({ goal: "x" }));
		await s.step("recording", patchStep({ goal: "y" }));
		expect(s.sends.map((sent) => sent.payload.customType)).toEqual([...engageAsideTypes, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE]);

		// The new session carries the rewound branch: invocation, head, goal:x.
		const rewound = omp.session("s2", { branch: procedureBranch("procedure", {}, { goal: "x" }) });
		await s.rewindTo(rewound);

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "branch")]);
		expect(rewound.notices).toEqual(engageNotices("procedure"));
		// The re-derive re-sent nothing: the head is already on the branch.
		expect(rewound.sends).toEqual([]);

		await rewound.step("recording", patchStep({ extra: 1 }));
		expect(rewound.storedStates.at(-1)).toEqual({ goal: "x", extra: 1 });
	});

	test("tree navigation re-derives like a rewind", async () => {
		const s = fakeOmp([procedure]).session("s1", { branch: procedureBranch("procedure", {}, { goal: "x" }) });

		await s.tree("l2");

		expect(s.notices).toEqual(engageNotices("procedure"));
		expect(s.sends).toEqual([]);
		await s.step("recording", patchStep({ extra: 1 }));
		expect(s.storedStates.at(-1)).toEqual({ goal: "x", extra: 1 });
	});

	test("/resume of an engaged session re-derives its state and re-engages without resending the head", async () => {
		const { omp, s } = await engaged();
		const target = omp.session("s2", { branch: procedureBranch("procedure", {}, { goal: "x" }) });

		await s.switchTo(target, "resume");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/resume")]);
		expect(target.notices).toEqual(engageNotices("procedure"));
		expect(target.sends).toEqual([]);
		await target.step("recording", patchStep({ extra: 1 }));
		expect(target.storedStates.at(-1)).toEqual({ goal: "x", extra: 1 });
	});

	test("/new starts the next session inert", async () => {
		const { omp, s } = await engaged();
		const fresh = omp.session("s2");

		await s.switchTo(fresh, "new");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
		expect(fresh.notices).toEqual([]);
		expect(await fresh.step("recording", patchStep({ goal: "x" }))).toBeUndefined();
		expect(fresh.sends).toEqual([]);
	});

	test("cold session_start re-engages from the branch without resending the head", async () => {
		const s = fakeOmp([procedure]).session("s1", { branch: procedureBranch("procedure", { goal: "x" }) });

		await s.start();

		expect(s.notices).toEqual(engageNotices("procedure"));
		expect(s.sends).toEqual([]);
		await s.step("recording", patchStep({ extra: 1 }));
		expect(s.storedStates.at(-1)).toEqual({ goal: "x", extra: 1 });
	});

	test("session_start stays inert without a usable procedure on the branch", async () => {
		const empty = fakeOmp([procedure]).session("s1");
		await empty.start();
		expect(empty.notices).toEqual([]);
		expect(await empty.step("recording", patchStep({ goal: "x" }))).toBeUndefined();

		const agent = fakeOmp([procedure]).session("s1", {
			branch: [invocationEntry("procedure", "agent"), specEntry("procedure"), ...stateEntries({ goal: "x" })],
		});
		await agent.start();
		expect(agent.notices).toEqual([]);

		const schemaless = fakeOmp([plain]).session("s1", { branch: procedureBranch("plain", { goal: "x" }) });
		await schemaless.start();
		expect(schemaless.notices).toEqual([]);
		expect(await schemaless.step("recording", patchStep({ goal: "x" }))).toBeUndefined();

		const sub = fakeOmp([procedure]).session("s1", { kind: "sub", branch: procedureBranch("procedure", { goal: "x" }) });
		await sub.start();
		expect(sub.notices).toEqual([]);

		// Without the stored P there is no head to re-send after a compaction.
		const specless = fakeOmp([procedure]).session("s1", { branch: [invocationEntry("procedure"), ...stateEntries({ goal: "x" })] });
		await specless.start();
		expect(specless.notices).toEqual([]);
	});

	test("a later invocation re-derives with its own state, never the earlier skill's", async () => {
		const s = fakeOmp([procedure, smallProcedure]).session("s1", {
			branch: [...procedureBranch("procedure", { goal: "old" }), ...procedureBranch("smallcap", { goal: "new" })],
		});

		await s.start();

		expect(s.notices).toEqual(engageNotices("smallcap"));
		await s.step("recording", patchStep({ extra: 1 }));
		expect(s.storedStates.at(-1)).toEqual({ goal: "new", extra: 1 });
	});

	test("an invocation with no state message after it stays inert, even when an earlier procedure left one", async () => {
		const s = fakeOmp([procedure, smallProcedure]).session("s1", {
			branch: [...procedureBranch("procedure", { goal: "old" }), ...procedureBranch("smallcap")],
		});

		await s.start();

		expect(s.notices).toEqual([]);
		expect(await s.step("recording", patchStep({ goal: "x" }))).toBeUndefined();
	});

	test("a branch whose head holds a state core but no scratch state stays inert", async () => {
		const s = fakeOmp([procedure]).session("s1", {
			branch: [invocationEntry("procedure"), specEntry("procedure"), coreStateEntry({ goal: "x" })],
		});

		await s.start();

		expect(s.notices).toEqual([]);
		expect(await s.step("recording", patchStep({ goal: "x" }))).toBeUndefined();
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
		const baseDir = path.join(import.meta.dir, "..", "skills", "zstate");
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

describe("omp-skill-state first-step rules", () => {
	// A session that has invoked the procedure skill: engaged, head asides
	// pending until the first step boundary.
	async function engaged(skills: Skill[] = [procedure], id = "s1") {
		const omp = fakeOmp(skills);
		const s = omp.session(id);
		await s.invoke("procedure");
		return { omp, s };
	}

	test("delivers the rules message on the engage batch, byte-equal to the stored head copy", async () => {
		const { s } = await engaged();

		expect(s.injected).toEqual([{ customType: RULES_MESSAGE_TYPE, content: OPERATING_RULES, display: false }]);
		expect(s.injected[0]).toEqual(s.sends[0].payload);
	});

	test("the injected copy sits in the branch before the boundary-flushed head asides", async () => {
		const { s } = await engaged();
		expect(s.branch.filter((entry) => entry.type === "custom_message").map((entry) => entry.customType)).toEqual(["skill-prompt", RULES_MESSAGE_TYPE]);

		await s.step("first");
		expect(s.branch.filter((entry) => entry.type === "custom_message").map((entry) => entry.customType)).toEqual([
			"skill-prompt",
			RULES_MESSAGE_TYPE,
			RULES_MESSAGE_TYPE,
			PROCEDURE_SPEC_MESSAGE_TYPE,
			STATE_CORE_MESSAGE_TYPE,
			STATE_SCRATCH_MESSAGE_TYPE,
		]);
	});

	test("step 1 sees the rules on ordinary context, before any projected head exists", async () => {
		const { s } = await engaged();

		expect(await s.step("first")).toBeUndefined();
		const rules = s.lastContextMessages?.find(
			(message): message is Record<string, unknown> =>
				typeof message === "object" && message !== null && "customType" in message && message.customType === RULES_MESSAGE_TYPE,
		);
		expect(rules).toEqual({ role: "custom", customType: RULES_MESSAGE_TYPE, content: OPERATING_RULES, display: false, details: undefined, timestamp: expect.any(Number) });
	});

	test("step 2 projects from the stored head: the last rules copy wins", async () => {
		const { s } = await engaged();
		await s.step("first");
		await s.step("second");

		const head = s.prompts.at(-1)?.[0];
		if (typeof head !== "object" || head === null || !("customType" in head) || !("content" in head)) throw new Error("step 2 ran without a projected head");
		expect(head.customType).toBe(RULES_MESSAGE_TYPE);
		expect(head.content).toBe(OPERATING_RULES);
	});

	test("no delivery for a skill without a state schema", async () => {
		const s = fakeOmp([plain]).session("s1");
		await s.invoke("plain");

		expect(s.injected).toEqual([]);
	});

	test("no delivery for a plain prompt", async () => {
		const s = fakeOmp([procedure]).session("s1");

		expect(await s.prompt("hello")).toBeUndefined();
		expect(s.injected).toEqual([]);
	});

	test("no delivery for an agent-attributed invocation", async () => {
		const s = fakeOmp([procedure]).session("s1");
		await s.invoke("procedure", { attribution: "agent" });

		expect(s.injected).toEqual([]);
	});

	test("no delivery in a subagent session", async () => {
		const s = fakeOmp([procedure]).session("sub", { kind: "sub" });
		await s.invoke("procedure");

		expect(s.injected).toEqual([]);
		expect(s.notices).toEqual([]);
	});

	test("no delivery for a mid-procedure steer prompt", async () => {
		const { s } = await engaged();
		await s.step("first");

		expect(await s.prompt("steer: also check x")).toBeUndefined();
		expect(s.injected).toHaveLength(1);
	});
});

describe("omp-skill-state patch loop", () => {
	// An engaged session: the head asides are pending until the first step
	// boundary, which is where the recorded pi left every patch test too.
	async function engaged(skill: Skill = procedure) {
		const omp = fakeOmp([skill]);
		const s = omp.session("s1");
		await s.invoke(skill.name);
		return { omp, s };
	}

	test("the renderers show keys collapsed and pretty JSON expanded, never the raw one-liner", () => {
		const omp = fakeOmp([procedure]);
		const theme = { fg: (_color: string, text: string) => text };
		const render = (type: string, expanded: boolean, state: ExecutionState) => {
			const renderer = omp.renderers.get(type) as
				| ((message: unknown, options: { expanded: boolean }, theme: unknown) => { getText(): string })
				| undefined;
			if (renderer === undefined) throw new Error(`no renderer registered for ${type}`);
			return renderer({ role: "custom", customType: type, content: renderStateContent(state), display: true, details: { state }, timestamp: Date.now() }, { expanded }, theme).getText();
		};

		for (const type of [STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE]) {
			const collapsed = render(type, false, { goal: "g" });
			expect(collapsed).toContain("goal");
			expect(collapsed).not.toContain('{"goal":"g"}');

			const expanded = render(type, true, { goal: "g" });
			expect(expanded).toContain('"goal": "g"');
		}
	});

	// With an empty state both partitions collapse to the same text, which read
	// as one notify printed twice (2026-10-12 zstate run); the label must say
	// which partition a line carries.
	test("the collapsed labels name the partition, so core and scratch never render identically", () => {
		const omp = fakeOmp([procedure]);
		const theme = { fg: (_color: string, text: string) => text };
		const render = (type: string, state: ExecutionState) => {
			const renderer = omp.renderers.get(type) as
				| ((message: unknown, options: { expanded: boolean }, theme: unknown) => { getText(): string })
				| undefined;
			if (renderer === undefined) throw new Error(`no renderer registered for ${type}`);
			return renderer({ role: "custom", customType: type, content: renderStateContent(state), display: true, details: { state }, timestamp: Date.now() }, { expanded: false }, theme).getText();
		};

		expect(render(STATE_CORE_MESSAGE_TYPE, { goal: "g" })).toContain("core");
		expect(render(STATE_SCRATCH_MESSAGE_TYPE, { goal: "g" })).toContain("scratch");
		// The empty-state case: both partitions are {} yet the lines must differ.
		expect(render(STATE_CORE_MESSAGE_TYPE, {})).not.toBe(render(STATE_SCRATCH_MESSAGE_TYPE, {}));
	});

	test("no state_update call is an empty patch: nothing sent, tool calls run", async () => {
		const { s } = await engaged();

		await s.step("Prose only, calling a tool.");

		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);
		expect(s.blocked).toEqual([]);
	});

	test("a valid state_update call commits the patch and the core+scratch asides land at the step boundary", async () => {
		const { s } = await engaged();

		await s.step("recording", patchStep({ goal: "x" }));

		expect(s.sends).toHaveLength(6);
		expect(s.sends.slice(4)).toEqual(stateSends({ goal: "x" }, "aside"));
		expect(s.blocked).toEqual([]);
		// Stored at the step boundary, before the next provider call.
		expect(s.storedStates).toEqual([{}, { goal: "x" }]);
	});

	test("several state_update calls in one batch all validate and commit in order", async () => {
		const { s } = await engaged();

		await s.step("recording", {
			tools: [STATE_UPDATE_TOOL_NAME, STATE_UPDATE_TOOL_NAME],
			arguments: [{ patch: { findings: { $append: ["a"] } } }, { patch: { next_step: "b" } }],
		});

		expect(s.blocked).toEqual([]);
		// One core+scratch pair per accepted patch: the executes fold in
		// declaration order, so the second commit carries both keys.
		expect(s.storedStates).toEqual([{}, { findings: ["a"] }, { findings: ["a"], next_step: "b" }]);
	});

	test("a valid patch followed by an invalid one refuses the whole batch before any tool runs", async () => {
		const { s } = await engaged();

		await s.step("recording", {
			tools: [STATE_UPDATE_TOOL_NAME, STATE_UPDATE_TOOL_NAME],
			arguments: [{ patch: { goal: "x" } }, { patch: { goal: 42 } }],
		});

		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);
		expect(s.blocked.map((call) => call.toolName)).toEqual([STATE_UPDATE_TOOL_NAME, STATE_UPDATE_TOOL_NAME]);
		for (const call of s.blocked) expect(call.reason).toContain('state key "goal" must be a string');
		expect(s.storedStates).toEqual([{}]);
	});

	test("a null patch on a declared key clears it instead of blocking, as the operating rules promise", async () => {
		const { s } = await engaged();

		await s.step("recording", patchStep({ goal: "x" }));
		await s.step("dropping", patchStep({ goal: null }));

		expect(s.blocked).toEqual([]);
		expect(s.storedStates).toEqual([{}, { goal: "x" }, {}]);
	});

	test("an $append patch grows a declared array key without resending it", async () => {
		const { s } = await engaged();

		await s.step("recording", patchStep({ findings: ["one"] }));
		await s.step("recording", patchStep({ findings: { $append: ["two"] } }));

		expect(s.blocked).toEqual([]);
		expect(s.storedStates.at(-1)).toEqual({ findings: ["one", "two"] });
	});

	test("a second valid patch merges into the first instead of replacing it", async () => {
		const { s } = await engaged();

		await s.step("recording", patchStep({ goal: "x" }));
		await s.step("recording", patchStep({ extra: 1 }));

		expect(s.sends).toHaveLength(8);
		// goal is declared, so it rides in the core; the undeclared extra is scratch.
		expect(s.sends[6]!.payload).toEqual(coreMessage({ goal: "x" }) as Record<string, unknown>);
		expect(s.sends[7]!.payload).toEqual(scratchMessage({ extra: 1 }) as Record<string, unknown>);
		expect(s.storedStates.at(-1)).toEqual({ goal: "x", extra: 1 });
	});

	test("an invalid patch blocks every call of the batch, the state_update call included, with the exact validation error", async () => {
		const { s } = await engaged();

		await s.step("recording", patchStep({ goal: 42 }, ["read", "bash"]));

		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);
		expect(s.blocked.map((call) => call.toolName)).toEqual([STATE_UPDATE_TOOL_NAME, "read", "bash"]);
		for (const call of s.blocked) expect(call.reason).toBe('state key "goal" must be a string (was number)');
	});

	test("a state_update call without a patch argument blocks with the shape error", async () => {
		const { s } = await engaged();

		await s.step("recording", { tools: [STATE_UPDATE_TOOL_NAME] });

		expect(s.blocked.map((call) => call.toolName)).toEqual([STATE_UPDATE_TOOL_NAME]);
		expect(s.blocked[0]!.reason).toBe("state patch must be a JSON object");
	});

	test("a valid retry recovers and the session stays engaged", async () => {
		const { omp, s } = await engaged();

		await s.step("recording", patchStep({ goal: 42 }));
		await s.step("recording", patchStep({ goal: "x" }));

		// Only the failed step's calls were blocked; the retry's call ran.
		expect(s.blocked).toHaveLength(1);
		expect(s.sends).toHaveLength(6); // engage asides plus the recovered core+scratch pair

		await s.switchTo(omp.session("s2"), "new");
		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
	});

	test("the third consecutive invalid patch degrades and the session runs ordinarily", async () => {
		const { omp, s } = await engaged();

		for (let i = 0; i < 3; i++) await s.step("recording", patchStep({ goal: 42 }));

		expect(s.notices).toEqual([
			...engageNotices("procedure"),
			{ message: 'skill-state: procedure "procedure" degraded after 3 invalid patches; running ordinarily', type: "warning" },
		]);
		// The degrading step runs its tools as an ordinary step would: only the
		// first two steps were blocked.
		expect(s.blocked).toHaveLength(2);

		await s.step("recording", patchStep({ goal: 42 }));
		expect(s.blocked).toHaveLength(2);
		// Disengaged: the state_update call is not blocked, but its execute
		// meets no procedure and stores nothing.
		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);
		expect(s.storedStates).toEqual([{}]);

		await s.switchTo(omp.session("s2"), "new");
		expect(s.notices).toEqual([
			...engageNotices("procedure"),
			{ message: 'skill-state: procedure "procedure" degraded after 3 invalid patches; running ordinarily', type: "warning" },
		]);
	});

	test("the degrade threshold honours x-state retries", async () => {
		const { s } = await engaged(retryProcedure);

		await s.step("recording", patchStep({ goal: 42 }));
		expect(s.notices).toEqual(engageNotices("retryproc"));

		await s.step("recording", patchStep({ goal: 42 }));
		expect(s.notices).toEqual([
			...engageNotices("retryproc"),
			{ message: 'skill-state: procedure "retryproc" degraded after 2 invalid patches; running ordinarily', type: "warning" },
		]);
	});

	test("a valid patch between failures resets the consecutive counter", async () => {
		const { omp, s } = await engaged();

		await s.step("recording", patchStep({ goal: 42 }));
		await s.step("recording", patchStep({ goal: 42 }));
		await s.step("recording", patchStep({ goal: "x" }));
		await s.step("recording", patchStep({ goal: 42 }));
		await s.step("recording", patchStep({ goal: 42 }));
		expect(s.notices).toEqual(engageNotices("procedure"));

		await s.switchTo(omp.session("s2"), "new");
		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
	});

	test("agent_end settles the live state as next-turn core and scratch once the session is idle", async () => {
		const { s } = await engaged();
		jest.useFakeTimers();
		try {
			await s.step("recording", patchStep({ goal: "x" }));
			// The run ends with a tool-free reply. Nothing is sent yet, because
			// the harness would only hold the message until the next prompt.
			await s.step("done", { tools: [] });
			expect(s.sends).toHaveLength(6);
			jest.advanceTimersByTime(100);
			expect(s.sends).toHaveLength(6);

			s.setIdle(true);
			jest.advanceTimersByTime(20);
			expect(s.sends).toHaveLength(8);
			expect(s.sends.slice(6)).toEqual(stateSends({ goal: "x" }, "nextTurn"));
			// Idle delivery lands on the branch at once, without a turn.
			expect(s.storedStates.at(-1)).toEqual({ goal: "x" });

			// A later run end settles the live state again: agent_end always
			// snapshots procedure.state.
			await s.step("again", { tools: [] });
			expect(s.sends.slice(8)).toEqual(stateSends({ goal: "x" }, "nextTurn"));
		} finally {
			jest.useRealTimers();
		}
	});

	test("a settle superseded by a later patch before the session is idle is dropped, not stored stale", async () => {
		const { s } = await engaged();
		jest.useFakeTimers();
		try {
			await s.step("done", { tools: [] });
			// A queued prompt ran another step before the session went idle.
			await s.step("recording", patchStep({ goal: "y" }));
			expect(s.sends).toHaveLength(6);
			expect(s.sends[4]!.payload).toEqual(coreMessage({ goal: "y" }) as Record<string, unknown>);

			s.setIdle(true);
			jest.advanceTimersByTime(5000);
			// The poll's snapshot predates the patch that moved the state, so
			// the stale copy is dropped and only the patch's asides went out.
			expect(s.sends).toHaveLength(6);
		} finally {
			jest.useRealTimers();
		}
	});

	test("a session that never goes idle still gets the live state after the poll budget, held by the harness for the next prompt", async () => {
		const { s } = await engaged();
		jest.useFakeTimers();
		try {
			await s.step("recording", patchStep({ goal: "x" }));
			await s.step("done", { tools: [] });
			jest.advanceTimersByTime(1900);
			expect(s.sends).toHaveLength(6);
			jest.advanceTimersByTime(200);
			expect(s.sends).toHaveLength(8);
			expect(s.sends.slice(6).map((sent) => sent.options)).toEqual([{ deliverAs: "nextTurn" }, { deliverAs: "nextTurn" }]);
			// Sent while busy: held to the next step boundary, not on the branch yet.
			expect(s.storedStates).toEqual([{}, { goal: "x" }]);
		} finally {
			jest.useRealTimers();
		}
	});

	test("assistant_message and tool_call are inert when not engaged and in a subagent", async () => {
		const omp = fakeOmp([procedure]);

		const main = omp.session("s1");
		await main.step("recording", patchStep({ goal: "x" }));
		expect(main.sends).toEqual([]);
		expect(main.blocked).toEqual([]);
		expect(main.notices).toEqual([]);

		const sub = omp.session("s2", { kind: "sub" });
		await sub.step("recording", patchStep({ goal: "x" }));
		expect(sub.sends).toEqual([]);
		expect(sub.blocked).toEqual([]);
		expect(sub.notices).toEqual([]);
	});
});

describe("omp-skill-state state_update registration", () => {
	test("registers the pinned definition at factory load, before any engage", async () => {
		const omp = fakeOmp([procedure]);
		const def = omp.tool(STATE_UPDATE_TOOL_NAME)!;
		expect(def.name).toBe(STATE_UPDATE_TOOL_NAME);
		expect(def.description).toBe(STATE_UPDATE_DESCRIPTION);
		expect(def.strict).toBe(true);
		// Zero approval: read tier with an explicit allow, so always-ask modes
		// never prompt for a state write.
		expect(def.approval).toEqual({ tier: "read", policy: "allow" });
		// The wrapper: exactly one patch argument, whose contents stay
		// unconstrained here (the state schema validates them in execute).
		const parameters = def.parameters as { parse(value: unknown): unknown };
		expect(parameters.parse({ patch: { goal: "x" } })).toEqual({ patch: { goal: "x" } });
		expect(() => parameters.parse({})).toThrow();
		expect(() => parameters.parse({ patch: "goal" })).toThrow();

		// The definition outlives engage and disengage alike: registration is
		// permanent for the session, and an engage adds nothing new.
		await omp.session("s1").invoke("procedure");
		await omp.session("s2").invoke("procedure");
		expect(omp.tool(STATE_UPDATE_TOOL_NAME)).toBe(def);
	});

	test("the definition requests top-level presentation: under tools.xdev a discoverable tool mounts as an xd:// device, where the patch would travel as freehand write content instead of protocol-level JSON (ADR 0002)", async () => {
		const omp = fakeOmp([procedure]);

		await omp.session("s1").invoke("procedure");

		expect(omp.tool(STATE_UPDATE_TOOL_NAME)!.loadMode).toBe("essential");
	});

	test("the operating rules name the tool the definition registers", async () => {
		const omp = fakeOmp([procedure]);
		await omp.session("s1").invoke("procedure");

		expect(omp.tool(STATE_UPDATE_TOOL_NAME)!.name).toBe(STATE_UPDATE_TOOL_NAME);
		expect(OPERATING_RULES).toContain(STATE_UPDATE_TOOL_NAME);
	});

	test("a direct execute applies a valid patch: commits and sends the core+scratch asides", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		await s.invoke("procedure");
		const def = omp.tool(STATE_UPDATE_TOOL_NAME)!;

		const result = await def.execute("t1", { patch: { goal: "x" } }, undefined, undefined, s.ctx());

		expect(result.isError).toBeUndefined();
		// The asides flushed at the next step boundary.
		await s.step("flush");
		expect(s.sends.slice(4)).toEqual(stateSends({ goal: "x" }, "aside"));
		expect(s.storedStates).toEqual([{}, { goal: "x" }]);
	});

	test("a direct execute with an invalid patch returns the exact error and stores nothing", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		await s.invoke("procedure");
		const def = omp.tool(STATE_UPDATE_TOOL_NAME)!;

		const result = await def.execute("t1", { patch: { goal: 42 } }, undefined, undefined, s.ctx());

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: 'state key "goal" must be a string (was number)' }]);
	});

	test("a direct execute after disengage returns the graceful no-active-procedure error", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		await s.invoke("procedure");
		await s.clear();
		const def = omp.tool(STATE_UPDATE_TOOL_NAME)!;

		const result = await def.execute("t1", { patch: { goal: "x" } }, undefined, undefined, s.ctx());

		expect(result).toEqual({ content: [{ type: "text", text: "no active procedure" }], isError: true });
		await s.step("ordinary");
		expect(s.storedStates).toEqual([{}]);
	});
});

describe("omp-skill-state idle disengage", () => {
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

	test("five consecutive no-patch steps disengage; four stay engaged", async () => {
		const { s } = await projecting();

		expect(await s.step("step 1")).toBeDefined();
		await s.step("step 2");
		await s.step("step 3");
		expect(s.notices).toEqual(engageNotices("procedure"));

		const quiet = await s.step("step 4");
		expect(nudgeIn(quiet)).toEqual([]);

		const prompt = await s.step("step 5");
		const nudge = nudgeIn(prompt);
		expect(nudge).toHaveLength(1);
		expect(nudge[0].content).toContain("unchanged for 4 consecutive steps");
		expect(prompt?.at(-1)).toBe(nudge[0]);
		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "idle for 5 steps")]);
	});

	test("the nudge rides on the prompt exactly once, at threshold minus one", async () => {
		const { s } = await projecting(warnProcedure);

		const quiet2 = await s.step("step 2");
		expect(nudgeIn(quiet2)).toEqual([]);

		const quiet3 = await s.step("step 3");
		expect(nudgeIn(quiet3)).toEqual([]);

		const prompt = await s.step("step 4");
		const nudge = nudgeIn(prompt);
		expect(nudge).toHaveLength(1);
		expect(nudge[0].role).toBe("developer");
		expect(nudge[0].content).toContain("unchanged for 2 consecutive steps");
		expect(nudge[0].content).toContain("disengage");
		expect(prompt?.at(-1)).toBe(nudge[0]);
		expect(s.notices).toEqual([...engageNotices("warnproc"), ...disengageNotices("warnproc", "idle for 3 steps")]);
	});

	test("the nudge is per-call: nothing is stored and nothing is sent", async () => {
		const { s } = await projecting(warnProcedure);

		await s.step("step 2");
		await s.step("step 3");
		const prompt = await s.step("step 4");
		expect(nudgeIn(prompt)).toHaveLength(1);
		expect(s.notices).toEqual([...engageNotices("warnproc"), ...disengageNotices("warnproc", "idle for 3 steps")]);
		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);
		expect(s.storedStates).toEqual([{}]);
	});

	test("a patch before the threshold resets the count and no nudge fires", async () => {
		const { s } = await projecting(warnProcedure);

		const quiet2 = await s.step("step 2");
		expect(nudgeIn(quiet2)).toEqual([]);

		const patched = await s.step("recording", patchStep({ goal: "x" }));
		expect(nudgeIn(patched)).toEqual([]);

		const quiet4 = await s.step("step 4");
		expect(nudgeIn(quiet4)).toEqual([]);

		const quiet5 = await s.step("step 5");
		expect(nudgeIn(quiet5)).toEqual([]);

		const prompt = await s.step("step 6");
		const nudge = nudgeIn(prompt);
		expect(nudge).toHaveLength(1);
		expect(nudge[0].content).toContain("unchanged for 2 consecutive steps");
		expect(s.notices).toEqual([...engageNotices("warnproc"), ...disengageNotices("warnproc", "idle for 3 steps")]);
	});

	test("a prompt that carries no head is never nudged", async () => {
		const s = fakeOmp([warnProcedure]).session("s1");
		await s.invoke("warnproc");

		// The engage asides land at the first step boundary; that step never saw
		// the rules, so the model cannot be idle in it.
		expect(await s.step("step 1")).toBeUndefined();
		const prompt = await s.step("step 2");
		expect(nudgeIn(prompt)).toEqual([]);
		expect(s.notices).toEqual(engageNotices("warnproc"));
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

		await s.step("recording", patchStep({ goal: "x" }));
		expect(s.sends).toHaveLength(6);

		await s.step("recording", patchStep({ goal: "x" }));
		expect(s.sends).toHaveLength(6);
		expect(s.notices).toEqual(engageNotices("idleproc"));

		await s.step("recording", patchStep({ goal: "x" }));
		expect(s.sends).toHaveLength(6);
		expect(s.storedStates).toEqual([{}, { goal: "x" }]);
		expect(s.notices).toEqual([...engageNotices("idleproc"), ...disengageNotices("idleproc", "idle for 2 steps")]);
	});

	test("a valid patch between idle steps resets the idle run", async () => {
		const { s } = await projecting();

		await s.step("no patch");
		await s.step("no patch");
		await s.step("recording", patchStep({ goal: "x" }));
		await s.step("no patch");
		await s.step("no patch");

		expect(s.notices).toEqual(engageNotices("procedure"));
	});

	test("an invalid patch also resets the idle run", async () => {
		const { s } = await projecting();

		await s.step("no patch");
		await s.step("no patch");
		await s.step("recording", patchStep({ goal: 42 }));
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

		await s.step("recording", patchStep({ goal: "x" }));
		expect(s.blocked).toEqual([]);
		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);
	});
});

describe("omp-skill-state state cap", () => {
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

	test("the consolidation nudge fires once per over-cap episode and re-arms on recovery", async () => {
		const { s } = await projecting(capProcedure);

		const growing = await s.step("recording", patchStep({ blob: "x".repeat(400) }));
		expect(nudgeIn(growing)).toEqual([]);

		const prompt = await s.step("step 3");
		const nudges = nudgeIn(prompt);
		expect(nudges).toHaveLength(1);
		expect(nudges[0].role).toBe("developer");
		expect(nudges[0].content).toContain("size cap");
		expect(prompt?.at(-1)).toBe(nudges[0]);

		const stillOver = await s.step("step 4");
		expect(nudgeIn(stillOver)).toEqual([]);

		const shrinking = await s.step("recording", patchStep({ blob: null }));
		expect(nudgeIn(shrinking)).toEqual([]);
		const underCap = await s.step("step 6");
		expect(nudgeIn(underCap)).toEqual([]);

		const regrowing = await s.step("recording", patchStep({ blob: "x".repeat(400) }));
		expect(nudgeIn(regrowing)).toEqual([]);
		const again = await s.step("step 8");
		const renudges = nudgeIn(again);
		expect(renudges).toHaveLength(1);
		expect(renudges[0].content).toContain("size cap");
	});

	test("the cap never blocks, never ends, and the nudge is never stored or sent", async () => {
		const { s } = await projecting(capProcedure);

		await s.step("recording", patchStep({ blob: "x".repeat(400) }));
		await s.step("step 3");
		await s.step("step 4");
		await s.step("recording", patchStep({ blob: null }));
		await s.step("step 6");
		await s.step("recording", patchStep({ blob: "x".repeat(400) }));
		await s.step("step 8");

		expect(s.blocked).toEqual([]);
		expect(s.notices).toEqual(engageNotices("capproc"));
		expect(s.sends.map((sent) => sent.payload.customType)).toEqual([
			...engageAsideTypes,
			STATE_CORE_MESSAGE_TYPE,
			STATE_SCRATCH_MESSAGE_TYPE,
			STATE_CORE_MESSAGE_TYPE,
			STATE_SCRATCH_MESSAGE_TYPE,
			STATE_CORE_MESSAGE_TYPE,
			STATE_SCRATCH_MESSAGE_TYPE,
		]);
		expect(s.storedStates).toEqual([{}, { blob: "x".repeat(400) }, {}, { blob: "x".repeat(400) }]);
	});

	test("a skill without a cap never carries a nudge on any prompt", async () => {
		const { s } = await projecting();

		await s.step("recording", patchStep({ goal: "x" }));
		await s.step("step 3");
		await s.step("step 4");

		for (const prompt of s.prompts) expect(nudgeIn(prompt)).toEqual([]);
	});
});

describe("omp-skill-state compaction ownership", () => {
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
		await s.step("recording", patchStep({ goal: "g" }));

		const pinned = s.branch.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").at(-1)!;
		const result = await s.compact({ firstKeptEntryId: "h1", tokensBefore: 4321 });

		const compaction = result?.compaction;
		expect(compaction?.firstKeptEntryId).toBe(pinned.id);
		expect(compaction?.firstKeptEntryId).not.toBe("a1");
		expect(compaction?.tokensBefore).toBe(4321);
		expect(compaction?.summary).toContain('Execution state of procedure "procedure"');
		expect(compaction?.summary).toContain(JSON.stringify({ goal: "g" }, null, 2));
		expect(compaction?.shortSummary).toContain('"procedure"');
		expect(compaction?.preserveData).toEqual({ core: { goal: "g" }, scratch: {} });
		// No summarizer step: session_before_compact itself sends nothing; the
		// four sends after the patch loop's are session_compact's head re-send.
		expect(s.sends.map((sent) => sent.payload.customType)).toEqual([...engageAsideTypes, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE, ...engageAsideTypes]);
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
		await s.step("recording", patchStep({ goal: "g" }));

		const first = await s.compact({ firstKeptEntryId: "e7", tokensBefore: 4321 });
		await s.step("recording", patchStep({ step: 2 }));
		const second = await s.compact({ firstKeptEntryId: "e9", tokensBefore: 5000, previousPreserveData: first?.compaction?.preserveData });

		expect(first?.compaction?.preserveData).toEqual({ core: { goal: "g" }, scratch: {} });
		expect(second?.compaction?.tokensBefore).toBe(5000);
		expect(second?.compaction?.preserveData).toEqual({ core: { goal: "g" }, scratch: { step: 2 } });
	});

	test("after a compaction the head is sent again, byte-equal, so the projection survives the cut", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		await s.invoke("procedure");
		await s.step("recording", patchStep({ goal: "g" }));

		await s.compact();

		expect(s.sends.map((sent) => sent.payload.customType)).toEqual([...engageAsideTypes, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE, ...engageAsideTypes]);
		expect(s.sends.slice(6).map((sent) => sent.payload)).toEqual([s.sends[0]!.payload, s.sends[1]!.payload, s.sends[4]!.payload, s.sends[5]!.payload]);
		// Mid-run: asides, so the copies land before the next provider call.
		expect(s.sends.slice(6).map((sent) => sent.options)).toEqual([{ deliverAs: "aside" }, { deliverAs: "aside" }, { deliverAs: "aside" }, { deliverAs: "aside" }]);

		// The cut kept the pre-compaction head, so the step right after the
		// compaction still projects, pinning the step before as its observation.
		const projected = await s.step("continue");
		expect(projected?.slice(0, 4).map((message) => (message as { customType?: string }).customType)).toEqual(engageAsideTypes);
		expect(projected?.[0] as Record<string, unknown>).toMatchObject(s.sends[0]!.payload);
		expect(projected?.[1] as Record<string, unknown>).toMatchObject(s.sends[1]!.payload);
		expect(projected?.[2] as Record<string, unknown>).toMatchObject(s.sends[4]!.payload);
		expect(projected?.[3] as Record<string, unknown>).toMatchObject(s.sends[5]!.payload);
		expect(projected?.slice(4)).toHaveLength(2);

		// The copies flushed at that step boundary, so the next provider call
		// carries them: the head is complete again after the cut.
		const after = await s.step("done", { tools: [] });
		expect(after?.[0] as Record<string, unknown>).toMatchObject(s.sends[6]!.payload);
		expect(after?.[1] as Record<string, unknown>).toMatchObject(s.sends[7]!.payload);
		expect(after?.[2] as Record<string, unknown>).toMatchObject(s.sends[8]!.payload);
		expect(after?.[3] as Record<string, unknown>).toMatchObject(s.sends[9]!.payload);
		// The default window pins both stored pairs: the pre-cut step and the
		// step right after the compaction.
		expect(after?.slice(4)).toHaveLength(4);
	});

	test("a compaction while idle re-sends the head as next-turn messages, which wake no turn", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		s.setIdle(true);
		await s.invoke("procedure");

		await s.compact();

		expect(s.sends).toHaveLength(8);
		expect(s.sends.slice(4).map((sent) => sent.options)).toEqual([{ deliverAs: "nextTurn" }, { deliverAs: "nextTurn" }, { deliverAs: "nextTurn" }, { deliverAs: "nextTurn" }]);
	});

	test("a re-derived engagement re-heads with the P and state stored on the branch", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1", { branch: procedureBranch("procedure", {}, { goal: "x" }) });
		await s.start();

		await s.compact();

		expect(s.sends.map((sent) => sent.payload)).toEqual([
			{ customType: RULES_MESSAGE_TYPE, content: OPERATING_RULES, display: false },
			{ customType: PROCEDURE_SPEC_MESSAGE_TYPE, content: "Running skill procedure", display: false, details: { name: "procedure" } },
			{ customType: STATE_CORE_MESSAGE_TYPE, content: renderStateContent({ goal: "x" }), display: true, details: { state: { goal: "x" } } },
			{ customType: STATE_SCRATCH_MESSAGE_TYPE, content: renderStateContent({}), display: true, details: { state: {} } },
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

		expect(prompt).toHaveLength(8);
		// The head and the pinned calls are the stored objects themselves: byte
		// equality with history is what anchors the provider cache prefix. The
		// injected first-step rules copy sits at input[1], so the head asides
		// start one entry later than the skill prompt alone would put them.
		expect(prompt?.[0]).toBe(input[4]);
		expect(prompt?.[1]).toBe(input[5]);
		expect(prompt?.[2]).toBe(input[6]);
		// The scratch rides as the per-call copy: not the stored reference,
		// but the same model-visible content.
		const projectedScratch = prompt?.[3];
		const storedScratch = input[7];
		if (!isCustomMessage(projectedScratch) || !isCustomMessage(storedScratch)) throw new Error("scratch head message is not a custom message");
		expect(projectedScratch).not.toBe(storedScratch);
		expect(projectedScratch.content).toBe(storedScratch.content);
		// The default window pins both stored pairs; their combined text shares
		// the 300-byte cap, so the largest result carries the truncation marker.
		const capped = prompt?.[7] as { content: Array<{ type: string; text?: string }>; toolCallId: string };
		expect(capped.toolCallId).toBe((input[9] as { toolCallId: string }).toolCallId);
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

		expect(prompt).toHaveLength(5);
		expect(prompt?.[0]).toBe(s.lastContextMessages?.[4]);
		expect(prompt?.[4]).toBe(s.lastContextMessages?.at(-1));
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
		expect(prompt?.[5]).not.toBe(message);
	});

	test("engaged: the bundled schema's observation window pins six pairs", async () => {
		const omp = fakeOmp([windowProcedure]);
		const s = omp.session("s1");
		await s.invoke("zstate");
		// The first step runs before the engage asides land; from the second one
		// the projection pins the step before as the observation.
		await s.step("warm-up");
		await s.step("step one");
		await s.step("step two");
		await s.step("step three");
		await s.step("step four");
		await s.step("step five");
		await s.step("step six");

		const prompt = await s.step("done", { tools: [] });

		expect(prompt).toHaveLength(16);
		// One id per message: the assistant's toolCall id, or the result's
		// message-level toolCallId. The session counter feeds both call ids and
		// entry ids, and each step consumes three (call id, assistant entry,
		// result entry) after the invoke's two entries, so the six pinned pairs
		// are call-10/13/16/19/22/25 and the dropped warm-up pair is call-3.
		const ids = (prompt ?? []).map((message) => {
			const { toolCallId, content } = message as { toolCallId?: unknown; content?: unknown };
			if (typeof toolCallId === "string") return toolCallId;
			if (!Array.isArray(content)) return "";
			for (const block of content as Array<{ type?: string; id?: string }>) {
				if (block.type === "toolCall" && typeof block.id === "string") return block.id;
			}
			return "";
		});
		expect(ids.filter(Boolean)).toEqual([
			"call-10", "call-10", "call-13", "call-13", "call-16", "call-16",
			"call-19", "call-19", "call-22", "call-22", "call-25", "call-25",
		]);
	});

	test("the bundled zstate schema loads the extended limits", async () => {
		const loaded = await loadStateSchema("zstate", [windowProcedure]);

		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.params.observationWindow).toBe(6);
		expect(loaded.params.observationBytes).toBe(65536);
		expect(loaded.params.stateBytes).toBe(32768);
		expect(loaded.params.idleSteps).toBe(8);
	});
});
