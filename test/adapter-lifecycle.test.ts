import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { PROCEDURE_SPEC_MESSAGE_TYPE, RULES_MESSAGE_TYPE, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE, renderStateContent, rulesMessage } from "../src/messages";
import { coreStateEntry, invocationEntry, mirrorEntry, procedureBranch, scratchStateEntry, specEntry, stateEntries } from "./entries";
import { fakeOmp } from "./fake-session";
import { disengageNotices, engagedSession, engageAsideTypes, engageNotices, makeSkillSet, nudgeIn, patchStep, procedureSchema, projectingSession, smallcapSchema } from "./harness";

const fx = await makeSkillSet({
	procedure: JSON.stringify(procedureSchema),
	plain: undefined,
	brokenarray: "[]",
	brokenjson: "{ not json",
	smallcap: JSON.stringify(smallcapSchema),
	idleproc: JSON.stringify({ ...procedureSchema, "x-state": { idleSteps: 2 } }),
	quietproc: JSON.stringify({ ...procedureSchema, "x-state": { idleSteps: 3 } }),
});
afterAll(() => rm(fx.root, { recursive: true, force: true }));
const {
	procedure,
	plain,
	brokenarray: brokenArray,
	brokenjson: brokenJson,
	smallcap: smallProcedure,
	idleproc: idleProcedure,
	quietproc: quietProcedure,
} = fx.skills;

describe("omp-skill-state engage/disengage lifecycle", () => {

	test("engages on a user skill-prompt for a schema-bearing skill, with the two notices", async () => {
		const { s } = await engagedSession([procedure, plain]);

		expect(s.notices).toEqual(engageNotices("procedure"));
	});

	test("engage sends the rules, the procedure spec and the initial state core and scratch as four asides", async () => {
		const { s } = await engagedSession([procedure]);
		const rules = rulesMessage();
		if (typeof rules !== "object" || typeof rules.content !== "string") throw new Error("rules payload without text content");

		expect(s.sends.map((sent) => sent.payload)).toEqual([
			{ customType: RULES_MESSAGE_TYPE, content: rules.content, display: false },
			{ customType: PROCEDURE_SPEC_MESSAGE_TYPE, content: "Running skill procedure", display: false, details: { name: "procedure" } },
			{ customType: STATE_CORE_MESSAGE_TYPE, content: renderStateContent({}), display: true, details: { state: {}, stamp: 0 } },
			{ customType: STATE_SCRATCH_MESSAGE_TYPE, content: renderStateContent({}), display: true, details: { state: {}, stamp: 0 } },
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
		const { s } = await engagedSession([procedure]);
		await s.invoke("procedure");

		expect(s.notices).toEqual(engageNotices("procedure"));
	});

	test("engages once when two invocations arrive before the schema read resolves", async () => {
		const s = fakeOmp([procedure]).session("s1");

		await Promise.all([s.invoke("procedure"), s.invoke("procedure")]);

		expect(s.notices).toEqual(engageNotices("procedure"));
	});

	test("disengages on /new", async () => {
		const { omp, s } = await engagedSession([procedure]);

		await s.switchTo(omp.session("s2"), "new");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/new")]);
	});

	test("disengages on /resume", async () => {
		const { omp, s } = await engagedSession([procedure]);

		await s.switchTo(omp.session("s2"), "resume");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/resume")]);
	});

	test("disengages on a fork switch", async () => {
		const { omp, s } = await engagedSession([procedure]);

		await s.switchTo(omp.session("s2"), "fork");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "fork")]);
	});

	test("a rewind to before the invocation leaves the runtime inert", async () => {
		const { omp, s } = await engagedSession([procedure]);
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
		const { omp, s } = await engagedSession([procedure]);
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
		const { omp, s } = await engagedSession([procedure]);
		// The mirror agrees with the newest stored pair, so there is nothing
		// to repair: the re-derive re-sends nothing and seeds the mirror's
		// stamp, ordering the next commit above everything stored.
		const target = omp.session("s2", {
			branch: [...procedureBranch("procedure", {}, { goal: "x" }), mirrorEntry({ core: { goal: "x" }, scratch: {}, stamp: 1 })],
		});

		await s.switchTo(target, "resume");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/resume")]);
		expect(target.notices).toEqual(engageNotices("procedure"));
		expect(target.sends).toEqual([]);
		await target.step("recording", patchStep({ extra: 1 }));
		expect(target.storedStates.at(-1)).toEqual({ goal: "x", extra: 1 });
		// The repair re-send is the only send a re-derive may make, and it
		// happened not to; the commit's own mirror is the only new one.
		expect(target.mirrors).toEqual([{ core: { goal: "x" }, scratch: {}, stamp: 1 }, { core: { goal: "x" }, scratch: { extra: 1 }, stamp: 2 }]);
	});

	test("a stored head that disagrees with the newest mirror is repaired: the head is re-sent, unmirrored", async () => {
		const { omp, s } = await engagedSession([procedure]);
		// The stored pair shows the tampered state; the mirror holds the real
		// one. A resume must engage the mirror state and re-send the head so
		// the branch's visible state matches again.
		const target = omp.session("s2", {
			branch: [
				invocationEntry("procedure"),
				specEntry("procedure"),
				coreStateEntry({ goal: "tampered" }, { state: { goal: "tampered" }, stamp: 0 }),
				scratchStateEntry({}, { state: {}, stamp: 0 }),
				mirrorEntry({ core: { goal: "mirror" }, scratch: {}, stamp: 1 }),
			],
		});
		target.setIdle(true);

		await s.switchTo(target, "resume");

		expect(target.notices).toEqual(engageNotices("procedure"));
		expect(target.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);
		// The head carries the mirror's state and stamp; the re-send is a
		// re-send, not a commit, so no mirror rides.
		expect(target.sends.map((sent) => sent.payload.details)).toEqual([
			undefined,
			{ name: "procedure" },
			{ state: { goal: "mirror" }, stamp: 1 },
			{ state: {}, stamp: 1 },
		]);
		expect(target.sends.map((sent) => sent.options)).toEqual([{ deliverAs: "nextTurn" }, { deliverAs: "nextTurn" }, { deliverAs: "nextTurn" }, { deliverAs: "nextTurn" }]);
		expect(target.mirrors).toEqual([{ core: { goal: "mirror" }, scratch: {}, stamp: 1 }]);
		// The next commit builds on the mirror state, above the seed stamp.
		await target.step("recording", patchStep({ extra: 1 }));
		expect(target.storedStates.at(-1)).toEqual({ goal: "mirror", extra: 1 });
		expect(target.mirrors.at(-1)).toEqual({ core: { goal: "mirror" }, scratch: { extra: 1 }, stamp: 2 });
	});

	test("a fresh engage after an ended run seeds above the stamps the run left", async () => {
		// Run A ended and its stamped state messages stay on the branch. A
		// second invocation engages fresh; the head it sends must seed at the
		// branch's highest stamp, or stamp-first ordering hands the prompt to
		// the ended run's copies — the exact time-travel the stamp guards.
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1", {
			branch: [
				invocationEntry("procedure"),
				specEntry("procedure"),
				coreStateEntry({ goal: "ended" }, { state: { goal: "ended" }, stamp: 3 }),
				scratchStateEntry({}, { state: {}, stamp: 3 }),
			],
		});

		await s.invoke("procedure");
		await s.step("warm-up", { tools: [] });
		const prompt = await s.step("recording", { tools: [] });
		if (prompt === undefined) throw new Error("the step returned no prompt");

		const cores = prompt.filter((message): message is { role: "custom"; customType: string } => typeof message === "object" && message !== null && "role" in message && message.role === "custom" && "customType" in message && message.customType === STATE_CORE_MESSAGE_TYPE);
		expect(cores).toHaveLength(1);
		const core = cores[0]!;
		if (!("details" in core)) throw new Error("the projected core carries no details");
		// The fresh head carries the fresh state and ties the ended run's
		// stamp, winning it on the later position.
		expect(core.details).toEqual({ state: {}, stamp: 3 });
	});

	test("/new starts the next session inert", async () => {
		const { omp, s } = await engagedSession([procedure]);
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
		const { omp, s } = await engagedSession([procedure]);
		const fork = omp.session("s2", { branch: procedureBranch("procedure", { goal: "x" }) });

		await s.switchTo(fork, "fork");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "fork")]);
		expect(fork.notices).toEqual(engageNotices("procedure"));
		// The head asides are s1's sends; the fork's re-derive re-sent none.
		expect(fork.sends).toEqual([]);
	});

	test("disengages on tree navigation", async () => {
		const { s } = await engagedSession([procedure]);

		// The live branch holds the invocation but no head yet (the asides land at
		// the first step boundary), so the scan finds no procedure to re-derive.
		await s.tree("l2");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "tree navigation")]);
	});

	test("disengages on /clear input, including padded text", async () => {
		const { s } = await engagedSession([procedure]);

		await s.input("/clear");
		await s.input("  /clear  ");

		expect(s.notices).toEqual([...engageNotices("procedure"), ...disengageNotices("procedure", "/clear")]);
	});

	test("ignores input that is not exactly /clear", async () => {
		const { s } = await engagedSession([procedure]);

		await s.input("/clearx");
		await s.input("hello");

		expect(s.notices).toEqual(engageNotices("procedure"));
	});

	test("a repeated trigger after disengage notifies nothing", async () => {
		const { omp, s } = await engagedSession([procedure]);
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
	// Both copies build from the same shared rules body, which no longer
	// interpolates any per-skill parameter.
	const rulesContent = (() => {
		const rules = rulesMessage();
		if (typeof rules !== "object" || typeof rules.content !== "string") throw new Error("rules payload without text content");
		return rules.content;
	})();

	test("delivers the rules message on the engage batch, byte-equal to the stored head copy", async () => {
		const { s } = await engagedSession([procedure]);

		expect(s.injected).toEqual([{ customType: RULES_MESSAGE_TYPE, content: rulesContent, display: false }]);
		expect(s.injected[0]).toEqual(s.sends[0].payload);
	});

	test("the injected copy sits in the branch before the boundary-flushed head asides", async () => {
		const { s } = await engagedSession([procedure]);
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
		const { s } = await engagedSession([procedure]);

		// The unprojected step runs on ordinary context plus one fallback notice.
		const first = await s.step("first");
		if (first === undefined) throw new Error("the first step returned no prompt");
		const notices = nudgeIn(first);
		expect(notices).toHaveLength(1);
		const rules = s.lastContextMessages?.find(
			(message): message is Record<string, unknown> =>
				typeof message === "object" && message !== null && "customType" in message && message.customType === RULES_MESSAGE_TYPE,
		);
		expect(rules).toEqual({ role: "custom", customType: RULES_MESSAGE_TYPE, content: rulesContent, display: false, details: undefined, timestamp: expect.any(Number), attribution: "agent" });
	});

	test("step 2 projects from the stored head: the last rules copy wins", async () => {
		const { s } = await engagedSession([procedure]);
		await s.step("first");
		await s.step("second");

		const head = s.prompts.at(-1)?.[0];
		if (typeof head !== "object" || head === null || !("customType" in head) || !("content" in head)) throw new Error("step 2 ran without a projected head");
		expect(head.customType).toBe(RULES_MESSAGE_TYPE);
		expect(head.content).toBe(rulesContent);
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
		const { s } = await engagedSession([procedure]);
		await s.step("first");

		expect(await s.prompt("steer: also check x")).toBeUndefined();
		expect(s.injected).toHaveLength(1);
	});
});

describe("omp-skill-state idle ask", () => {
	test("a quiet run raises the idle ask once on the projected prompt and stores nothing", async () => {
		const { s } = await projectingSession(quietProcedure);

		// The step right after the boundary is degraded (the tail is still
		// empty) and policy-neutral; the three steps after it count idle, and
		// the ask rides on the prompt after the third.
		await s.step("the degraded step after the boundary");
		await s.step("step 3");
		await s.step("step 4");
		await s.step("step 5");
		const prompt = await s.step("step 6");
		const notices = nudgeIn(prompt);
		// The window notice rides first, the idle ask last.
		expect(notices).toHaveLength(2);
		expect(notices.map((notice) => String(notice.content))).toEqual([
			expect.stringContaining("tail oldest→newest"),
			expect.stringContaining("unchanged for 3 consecutive steps"),
		]);
		// A reminder, not a deadline: the run stays engaged, so no disengage
		// notice exists and no ask is stored or sent.
		expect(s.notices).toEqual(engageNotices("quietproc"));
		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);
		expect(s.storedStates).toEqual([{}]);
	});

	test("a later patch still commits and re-arms the ask", async () => {
		const { s } = await projectingSession(quietProcedure);
		await s.step("the degraded step after the boundary");
		await s.step("step 3");
		await s.step("step 4");
		await s.step("step 5");

		await s.step("recording", patchStep({ goal: "x" }));
		expect(s.blocked).toEqual([]);
		expect(s.sends.map((sent) => sent.payload.customType)).toEqual([...engageAsideTypes, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE]);
		expect(s.storedStates).toEqual([{}, { goal: "x" }]);

		// Quiet again: after idleSteps further idle steps the ask fires once more.
		await s.step("step 7");
		await s.step("step 8");
		await s.step("step 9");
		const prompt = await s.step("step 10");
		expect(nudgeIn(prompt).map((notice) => String(notice.content))).toEqual([
			expect.stringContaining("tail oldest→newest"),
			expect.stringContaining("unchanged for 3 consecutive steps"),
		]);
		expect(s.notices).toEqual(engageNotices("quietproc"));
	});

	test("a long quiet run stays engaged across many steps and asks exactly once", async () => {
		const { s } = await projectingSession(idleProcedure);

		await s.step("the degraded step after the boundary");
		let asks = 0;
		for (let i = 0; i < 8; i++) {
			const prompt = await s.step(`quiet step ${i}`);
			asks += nudgeIn(prompt).filter((notice) => String(notice.content).includes("unchanged for")).length;
		}
		expect(asks).toBe(1);
		expect(s.notices).toEqual(engageNotices("idleproc"));

		// Still engaged: a patch after the long quiet run still commits.
		await s.step("recording", patchStep({ goal: "x" }));
		expect(s.blocked).toEqual([]);
		expect(s.storedStates).toEqual([{}, { goal: "x" }]);
	});
});
