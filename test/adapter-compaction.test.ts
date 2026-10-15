import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { PROCEDURE_SPEC_MESSAGE_TYPE, RULES_MESSAGE_TYPE, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE, renderStateContent, rulesMessage } from "../src/messages";
import { procedureBranch } from "./entries";
import { fakeOmp } from "./fake-session";
import { disengageNotices, engageAsideTypes, engageNotices, makeSkillSet, patchStep, procedureSchema } from "./harness";

const fx = await makeSkillSet({ procedure: JSON.stringify(procedureSchema) });
afterAll(() => rm(fx.root, { recursive: true, force: true }));
const { procedure } = fx.skills;

describe("omp-skill-state compaction ownership", () => {
	test("registers session_before_compact lazily on the first engage, never at load", async () => {
		const omp = fakeOmp([procedure]);
		expect(omp.registered("session_before_compact")).toBe(false);

		await omp.session("s1").invoke("procedure");

		expect(omp.registered("session_before_compact")).toBe(true);
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
		// compaction still projects. Nothing is stored behind the re-sent head
		// yet, so the step is degraded: head plus notice, never history.
		const degraded = await s.step("continue");
		expect(degraded?.slice(0, 4).map((message) => (message as { customType?: string }).customType)).toEqual(engageAsideTypes);
		expect(degraded?.[0] as Record<string, unknown>).toMatchObject(s.sends[0]!.payload);
		expect(degraded?.[1] as Record<string, unknown>).toMatchObject(s.sends[1]!.payload);
		expect(degraded?.[2] as Record<string, unknown>).toMatchObject(s.sends[4]!.payload);
		expect(degraded?.[3] as Record<string, unknown>).toMatchObject(s.sends[5]!.payload);
		// The degradation notice, and no ordinary transcript behind the head.
		expect(degraded).toHaveLength(5);
		const notice = degraded?.[4];
		if (typeof notice !== "object" || notice === null || !("content" in notice) || typeof notice.content !== "string") {
			throw new Error("the degraded step returned no developer notice");
		}
		expect(notice.content).toContain("No recent transcript");

		// The copies flushed at that step boundary, so the next provider call
		// carries them: the head is complete again after the cut. That step is
		// degraded (nothing stored behind the re-sent head yet).
		const after = await s.step("done", { tools: [] });
		expect(after?.[0] as Record<string, unknown>).toMatchObject(s.sends[6]!.payload);
		expect(after?.[1] as Record<string, unknown>).toMatchObject(s.sends[7]!.payload);
		expect(after?.[2] as Record<string, unknown>).toMatchObject(s.sends[8]!.payload);
		expect(after?.[3] as Record<string, unknown>).toMatchObject(s.sends[9]!.payload);
		expect(after).toHaveLength(5);
		const afterNotice = after?.[4];
		if (typeof afterNotice !== "object" || afterNotice === null || !("content" in afterNotice) || typeof afterNotice.content !== "string") {
			throw new Error("the post-compaction step returned no developer notice");
		}
		expect(afterNotice.content).toContain("No recent transcript");

		// The step stored after the re-sent head rides as the whole tail: the
		// re-sent head bounds it, and no window notice rides (no tailed result).
		const tailStep = await s.step("after", { tools: [] });
		expect(tailStep).toHaveLength(5);
		const tailAssistant = tailStep?.[3];
		if (typeof tailAssistant !== "object" || tailAssistant === null || !("content" in tailAssistant) || !Array.isArray(tailAssistant.content)) {
			throw new Error("the tail assistant did not project");
		}
		expect(tailAssistant.content.some((block) => block.type === "text" && block.text === "done")).toBe(true);
		const closing = tailStep?.[4];
		if (typeof closing !== "object" || closing === null || !("role" in closing)) throw new Error("the prompt does not close on a custom message");
		expect(closing.role).toBe("custom");
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

		const rules = rulesMessage();
		if (typeof rules !== "object" || typeof rules.content !== "string") throw new Error("rules payload without text content");
		expect(s.sends.map((sent) => sent.payload)).toEqual([
			{ customType: RULES_MESSAGE_TYPE, content: rules.content, display: false },
			{ customType: PROCEDURE_SPEC_MESSAGE_TYPE, content: "Running skill procedure", display: false, details: { name: "procedure" } },
			{ customType: STATE_CORE_MESSAGE_TYPE, content: renderStateContent({ goal: "x" }), display: true, details: { state: { goal: "x" }, stamp: 0 } },
			{ customType: STATE_SCRATCH_MESSAGE_TYPE, content: renderStateContent({}), display: true, details: { state: {}, stamp: 0 } },
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
