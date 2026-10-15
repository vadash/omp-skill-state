import { afterAll, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { STATE_UPDATE_TOOL_NAME } from "../src/messages";
import { RULES_MESSAGE_TYPE, SKILL_PROMPT_MESSAGE_TYPE } from "../src/messages";
import { applyPatch, loadStateSchema, splitState, validatePatch } from "../src/state";
import { fakeOmp } from "./fake-session";
import { coreStateEntry, invocationEntry, scratchStateEntry, specEntry, stateEntry } from "./entries";
import { engageAsideTypes, engagedSession, engageNotices, makeSkillSet, nudgeIn, patchStep, procedureSchema, smallcapSchema } from "./harness";

// The real bundled schema, loaded from the repo so a change to its x-state
// limits flows into this suite.
const zstateSchema = await readFile(path.join(import.meta.dir, "..", "skills", "zstate", "state.schema.json"), "utf8");
const fx = await makeSkillSet({
	procedure: JSON.stringify(procedureSchema),
	smallcap: JSON.stringify(smallcapSchema),
	zstate: zstateSchema,
});
afterAll(() => rm(fx.root, { recursive: true, force: true }));
const { procedure, smallcap: smallProcedure, zstate: windowProcedure } = fx.skills;

describe("omp-skill-state projection (context seam)", () => {
	test("returns undefined for a subagent session and when not engaged", async () => {
		const omp = fakeOmp([procedure]);
		expect(await omp.session("s1").step("ordinary")).toBeUndefined();

		const sub = omp.session("s2", { kind: "sub" });
		await sub.invoke("procedure");
		expect(await sub.step("ordinary")).toBeUndefined();
	});

	test("engaged: the unprojected first step carries one fallback notice, never stored", async () => {
		const { s } = await engagedSession([procedure]);

		// The head asides land at the first boundary, so step 1 falls back to
		// ordinary context with exactly one developer notice riding it.
		const first = await s.step("first");
		if (first === undefined) throw new Error("the first step returned no prompt");
		const notices = nudgeIn(first);
		// The notice's wording is the unit suites' claim (messages, procedure);
		// here the wiring is the claim: one developer message rides, nothing else.
		expect(notices).toHaveLength(1);

		// The notice is per-call: only the four engage asides were stored.
		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);

		// The step right after the boundary is degraded: the head is in place
		// but nothing is stored behind it yet.
		const second = await s.step("second");
		expect(headCustomTypes(second!)).toEqual(engageAsideTypes);
		const degradedNotices = nudgeIn(second);
		expect(degradedNotices).toHaveLength(1);
		expect(String(degradedNotices[0]!.content)).toContain("No recent transcript");

		// From the third step the projection is normal: only the window notice
		// rides, listing the tail's pair tags.
		const third = await s.step("third");
		const windowNotices = nudgeIn(third);
		expect(windowNotices).toHaveLength(1);
		expect(String(windowNotices[0]!.content)).toContain("tail oldest→newest");
	});

	test("engaged: honours x-state observationBytes on real step results", async () => {
		const omp = fakeOmp([smallProcedure]);
		const s = omp.session("s1");
		await s.invoke("smallcap");
		// The first step runs before the engage asides land and the second is
		// degraded (the tail is still empty); from the third one the tail
		// carries every stored step.
		await s.step("warm-up");
		await s.step("working", { results: ["y".repeat(1000)] });

		const prompt = await s.step("done", { tools: [] });
		const input = s.lastContextMessages!;

		expect(prompt).toHaveLength(7);
		// The tail carries the stored pairs behind the head spine; the
		// oversized result is capped per result and carries the marker.
		const projected = prompt?.[4];
		if (typeof projected !== "object" || projected === null || !("toolCallId" in projected) || !("content" in projected) || !Array.isArray(projected.content)) {
			throw new Error("the oversized result did not project");
		}
		const pinned = input[9];
		if (typeof pinned !== "object" || pinned === null || !("toolCallId" in pinned)) throw new Error("the oversized result was not pinned");
		expect(projected.toolCallId).toBe(pinned.toolCallId);
		const total = projected.content.reduce(
			(sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text ?? "") : 0),
			0,
		);
		expect(total).toBeLessThanOrEqual(300);
		expect(projected.content.at(-1)?.text).toContain("result cap 300 bytes exceeded");
	});

	test("engaged: a user turn projects the head, the run's tail and the user message", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		await s.invoke("procedure");
		await s.step("warm-up");

		const prompt = await s.userTurn("go on");

		expect(prompt).toHaveLength(5);
		expect(prompt?.[0]).toBe(s.lastContextMessages?.[4]);
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
		await s.step("done", { tools: [] });

		expect(message.content).toEqual(snapshot);
	});

	test("engaged: the tail carries the run's recent conversation behind the state core, byte-equal to stored", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		await s.invoke("procedure");
		// The first step lands the head, the second is degraded; from the
		// third the tail carries the stored pairs behind the head spine.
		await s.step("warm-up");
		await s.step("second", { results: ["payload two"] });
		await s.step("third", { results: ["payload three"] });

		const prompt = await s.step("fourth", { tools: [] });
		const input = s.lastContextMessages!;

		expect(prompt).toHaveLength(9);
		// Prompt order: rules, spec, core, the tail (both earlier pairs, oldest
		// first), the scratch copy, the window notice.
		expect(headCustomTypes(prompt!).slice(0, 3)).toEqual(engageAsideTypes.slice(0, 3));
		const texts: string[] = [];
		for (const message of prompt ?? []) {
			if (typeof message !== "object" || message === null || !("content" in message) || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string") texts.push(block.text);
			}
		}
		expect(texts).toContain("payload two");
		expect(texts).toContain("payload three");
		// The tail's newest assistant message is the stored object itself.
		const storedAssistant = input.at(-2);
		expect(prompt?.[5]).toBe(storedAssistant);
	});

	test("engaged: the tail budget comes from the context-usage read, not a constant", async () => {
		const built = await makeSkillSet({ procedure: JSON.stringify(procedureSchema) });
		try {
			for (const [label, contextWindow] of [["small", 1500], ["large", 1_000_000]] as const) {
				const omp = fakeOmp([built.skills.procedure]);
				const s = omp.session("s1");
				s.contextUsage = { tokens: 0, contextWindow, percent: 0 };
				await s.invoke("procedure");
				await s.step("warm-up");
				await s.step("second");
				await s.step("third");

				// The projected prompt (head 3 + tail + scratch + notice): at the
				// small window the tail evicts down to the newest message, at the
				// large one every stored pair stays.
				const prompt = await s.step("fourth");
				const tailLength = (prompt?.length ?? 0) - 5;
				if (label === "small") expect(tailLength).toBe(1);
				else expect(tailLength).toBeGreaterThan(1);
			}
		} finally {
			await rm(built.root, { recursive: true, force: true });
		}
	});

	// The harness marks per-call any prompt message failing Bun.deepEquals
	// against its context-event counterpart (runner.ts emitContext), so a
	// rebuilt custom that drops `attribution` fails the compare, drags the
	// cache breakpoint before the tail and re-bills the run every step
	// (ADR 0011). The witness: the head customs compare equal to their
	// context copies; only the scratch clone deliberately differs.
	test("engaged: projected stored customs compare equal to their context copies, attribution included", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		await s.invoke("procedure");
		await s.step("warm-up");
		// A mid-run invocation puts a skill-prompt custom in the tail: the one
		// custom class the projection rebuilds from the branch rather than
		// passing through from the context list.
		await s.invoke("procedure");
		const prompt = await s.step("second", { results: ["payload"] });
		const input = s.lastContextMessages!;

		const customs = prompt!.filter((message) => typeof message === "object" && message !== null && "role" in message && message.role === "custom");
		// rules, spec, core, the tail's skill-prompt custom, the scratch clone.
		expect(customs).toHaveLength(5);
		for (const custom of customs.slice(0, 4)) {
			expect(input.some((candidate) => Bun.deepEquals(candidate, custom))).toBe(true);
		}
		expect(input.some((candidate) => Bun.deepEquals(candidate, customs[4]))).toBe(false);
	});

	test("engaged: a mid-run second invocation stays in the tail (the spine is the spec, not the rules)", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		await s.invoke("procedure");
		await s.step("warm-up");
		await s.step("second", { results: ["payload"] });

		// A mid-run second invocation: before_agent_start re-sends the rules
		// on the announcing batch while engaged, and message_end lands no new
		// spec — so the rules copy must not move the tail's start.
		await s.invoke("procedure");
		expect(s.injected).toHaveLength(2);

		const prompt = await s.step("third", { tools: [] });
		if (prompt === undefined) throw new Error("the step returned no prompt");
		// The mid-run invocation's skill prompt reaches the model through the
		// tail; the engage-time copy sits before the spine and does not.
		const skillPrompts = prompt.filter((message) => typeof message === "object" && message !== null && "role" in message && message.role === "custom" && "customType" in message && message.customType === SKILL_PROMPT_MESSAGE_TYPE);
		expect(skillPrompts).toHaveLength(1);
		// The rules ride once, in the head; the mid-run copy stays out.
		const rulesCopies = prompt.filter((message) => typeof message === "object" && message !== null && "role" in message && message.role === "custom" && "customType" in message && message.customType === RULES_MESSAGE_TYPE);
		expect(rulesCopies).toHaveLength(1);
	});

	// The pair tag in a projected tool result's first text block, or undefined.
	// Narrowed field by field: the prompt arrives as unknown[] from the fake.
	function pairTagOf(message: unknown): { callId: string; tag: string } | undefined {
		if (typeof message !== "object" || message === null) return undefined;
		if (!("role" in message) || message.role !== "toolResult") return undefined;
		if (!("toolCallId" in message) || typeof message.toolCallId !== "string") return undefined;
		if (!("content" in message) || !Array.isArray(message.content)) return undefined;
		const first = message.content[0];
		if (typeof first !== "object" || first === null) return undefined;
		if (!("type" in first) || first.type !== "text" || !("text" in first) || typeof first.text !== "string") return undefined;
		const match = first.text.match(/^\[#([0-9a-f]{4}) read\]\n/);
		return match === undefined ? undefined : { callId: message.toolCallId, tag: match[1] };
	}

	test("engaged: the projected prompt carries pair tags and the window notice, and a resume re-derives identical tags", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		await s.invoke("procedure");
		await s.step("warm-up");
		await s.step("working", { results: ["payload"] });
		await s.step("more", { results: ["third"] });
		const prompt = await s.step("fourth", { tools: [] });
		if (prompt === undefined) throw new Error("the third step returned no prompt");

		// The tailed results carry tag lines; the notice lists them oldest first.
		const tags: Record<string, string> = {};
		for (const message of prompt) {
			const tagged = pairTagOf(message);
			if (tagged !== undefined) tags[tagged.callId] = tagged.tag;
		}
		const [oldestId, nextId] = Object.keys(tags);
		if (oldestId === undefined || nextId === undefined) throw new Error("the prompt carried fewer than two tagged results");
		const notices = nudgeIn(prompt);
		expect(notices).toHaveLength(1);
		expect(notices[0]!.content).toBe(`tail oldest→newest: #${tags[oldestId]} read, #${tags[nextId]} read — oldest evict first when the prompt outgrows its budget`);

		// A resume re-derives from the branch and recomputes identical tags.
		const target = omp.session("s2", { branch: s.branch });
		await s.switchTo(target, "resume");
		await target.step("next", { results: ["more"] });
		const resumed = await target.step("after", { tools: [] });
		if (resumed === undefined) throw new Error("the resumed step returned no prompt");
		const resumedTagged: Array<{ callId: string; tag: string }> = [];
		for (const message of resumed) {
			const tagged = pairTagOf(message);
			if (tagged !== undefined) resumedTagged.push(tagged);
		}
		// The tail carries every stored result: the pre-resume pairs plus the
		// resumed step's own.
		expect(resumedTagged).toHaveLength(3);
		for (const tagged of resumedTagged) {
			if (tagged.callId in tags) expect(tags[tagged.callId]).toBe(tagged.tag);
		}
		const fresh = resumedTagged[2]!;
		expect(fresh.callId === oldestId || fresh.callId === nextId).toBe(false);
		const resumedNotices = nudgeIn(resumed);
		expect(resumedNotices).toHaveLength(1);
		expect(String(resumedNotices[0]!.content)).toBe(`tail oldest→newest: #${tags[oldestId]} read, #${tags[nextId]} read, #${fresh.tag} read — oldest evict first when the prompt outgrows its budget`);
	});

	test("the bundled zstate schema loads the extended limits", async () => {
		const loaded = await loadStateSchema("zstate", [windowProcedure]);

		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.params.promptBudgetPercent).toBe(30);
		expect(loaded.params.evictionChunkPercent).toBe(25);
		expect(loaded.params.observationBytes).toBe(65536);
		expect(loaded.params.stateBytes).toBe(32768);
		expect(loaded.params.idleSteps).toBe(8);
	});

	// The wiring witness for the knowledge-bag claim (issue #31): the bundled
	// schema's bag is a declared, non-volatile object key, so a patch writing
	// facts into it validates and the split lands it wholly in the state core.
	test("the bundled knowledge bag validates and lands in the state core", async () => {
		const loaded = await loadStateSchema("zstate", [windowProcedure]);
		if (!loaded.ok) throw new Error("the bundled zstate schema must load");
		const patch = { knowledge: { db_port: 5432 } };

		expect(validatePatch(patch, loaded.schema)).toBeNull();
		const applied = applyPatch({}, patch, loaded.schema);
		if (!applied.ok) throw new Error("the knowledge patch must apply");
		const { core, scratch } = splitState(applied.state, loaded.schema);
		expect(core).toEqual({ knowledge: { db_port: 5432 } });
		expect(scratch).toEqual({});
	});

	// The wiring witness for the narrowed degraded step (ADR 0010): a blocked
	// batch leaves its calls unanswered, and those stored calls stay in the
	// tail — the step is degraded only when nothing is stored behind the head.
	test("engaged: a blocked batch's unanswered calls stay in the tail, and an empty tail degrades in place", async () => {
		const { s } = await engagedSession([procedure]);
		await s.step("the first step lands the head");

		// An invalid patch co-batched with a read: the fold refuses the step,
		// so the tool_call handler blocks every call and no result is stored.
		await s.step("patching", patchStep({ goal: 42 }, ["read"]));
		expect(s.blocked.map((call) => call.toolName)).toEqual([STATE_UPDATE_TOOL_NAME, "read"]);

		// The next step's tail carries the unanswered assistant message: the
		// model sees its own calls again. No tailed result, so no window
		// notice, and no degradation notice: the tail is not empty.
		const afterBlock = await s.step("re-emitting");
		// Prompt: rules, spec, core, the unanswered assistant (the whole tail:
		// the pair landed before the spine), the scratch copy. No tailed
		// result, so no window notice; no degradation notice either: the tail
		// is not empty.
		expect(headCustomTypes(afterBlock!)).toEqual([...engageAsideTypes.slice(0, 3), undefined, engageAsideTypes[3]]);
		expect(nudgeIn(afterBlock)).toHaveLength(0);
		const unanswered = (afterBlock as unknown[] | undefined)?.[3];
		if (typeof unanswered !== "object" || unanswered === null || !("content" in unanswered) || !Array.isArray(unanswered.content)) {
			throw new Error("the unanswered assistant did not project");
		}
		expect(unanswered.content.some((block) => block.type === "toolCall")).toBe(true);

		// The re-emitted patch is valid, and the step after it carries the
		// window notice again.
		await s.step("recovering", patchStep({ goal: "x" }));
		const recovered = await s.step("reading");
		if (recovered === undefined) throw new Error("the recovered step returned no prompt");
		const recoveredNotices = nudgeIn(recovered);
		expect(recoveredNotices).toHaveLength(1);
		expect(String(recoveredNotices[0]!.content)).toContain("tail oldest");
	});

	// The true degraded witness: a re-derived branch whose head is complete
	// and behind which nothing is stored.
	test("engaged: head intact, tail empty — the step projects the head plus the degradation notice", async () => {
		const omp = fakeOmp([procedure]);
		// The head as committed on the branch: invocation, spec, rules, core,
		// scratch — the spine is complete and nothing is stored behind it.
		const branch = [
			invocationEntry("procedure"),
			specEntry("procedure"),
			stateEntry(RULES_MESSAGE_TYPE, {}),
			coreStateEntry({ goal: "x" }),
			scratchStateEntry({}),
		];
		const s = omp.session("s1", { branch });
		await s.start();
		expect(s.notices).toEqual(engageNotices("procedure"));

		const prompt = await s.step("reading");
		expect(headCustomTypes(prompt!)).toEqual(engageAsideTypes);
		expect(prompt).toHaveLength(5);
		const notices = nudgeIn(prompt);
		expect(notices).toHaveLength(1);
		expect(String(notices[0]!.content)).toContain("No recent transcript");
		expect(prompt?.some((message) => typeof message === "object" && message !== null && "role" in message && (message.role === "toolResult" || message.role === "user"))).toBe(false);
	});
});

// The customType list of a prompt's messages, undefined where the message is
// not a custom message. Narrowed field by field: the prompt arrives as
// unknown[] from the fake.
function headCustomTypes(prompt: unknown[]): (string | undefined)[] {
	return prompt.map((message) => {
		if (typeof message !== "object" || message === null) return undefined;
		if (!("role" in message) || message.role !== "custom") return undefined;
		if (!("customType" in message) || typeof message.customType !== "string") return undefined;
		return message.customType;
	});
}
