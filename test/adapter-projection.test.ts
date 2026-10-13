import { afterAll, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { loadStateSchema } from "../src/state";
import { fakeOmp } from "./fake-session";
import { engageAsideTypes, engagedSession, makeSkillSet, nudgeIn, procedureSchema, smallcapSchema } from "./harness";

// The real bundled schema, loaded from the repo so a change to its x-state
// window flows into this suite.
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

		// The next step projects: the episode is over, only the window notice rides.
		const second = await s.step("second");
		expect(nudgeIn(second)).toHaveLength(1);
		expect(String(nudgeIn(second)[0]!.content)).toContain("window oldest→newest");
	});

	test("engaged: honours x-state observationBytes on real step results", async () => {
		const omp = fakeOmp([smallProcedure]);
		const s = omp.session("s1");
		await s.invoke("smallcap");
		// The first step runs before the engage asides land; from the second one
		// the projection pins the step before as the observation.
		await s.step("warm-up");
		await s.step("working", { results: ["y".repeat(1000)] });

		const prompt = await s.step("done", { tools: [] });
		const input = s.lastContextMessages!;

		expect(prompt).toHaveLength(9);
		// The default window pins both stored pairs; their combined text shares
		// the 300-byte cap, so the largest result carries the truncation marker
		// and the cap lands on the pinned newest pair.
		const projected = prompt?.[7];
		if (typeof projected !== "object" || projected === null || !("toolCallId" in projected) || !("content" in projected) || !Array.isArray(projected.content)) {
			throw new Error("the newest pinned result did not project");
		}
		const pinned = input[9];
		if (typeof pinned !== "object" || pinned === null || !("toolCallId" in pinned)) throw new Error("the newest result was not pinned");
		expect(projected.toolCallId).toBe(pinned.toolCallId);
		const total = projected.content.reduce(
			(sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text ?? "") : 0),
			0,
		);
		expect(total).toBeLessThanOrEqual(300);
		expect(projected.content.at(-1)?.text).toContain("observation cap 300 bytes exceeded");
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

		// Six pinned pairs (12 messages), the head (4), and the window notice.
		expect(prompt).toHaveLength(17);
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
		const prompt = await s.step("more", { results: ["third"] });
		if (prompt === undefined) throw new Error("the third step returned no prompt");

		// The windowed results carry tag lines; the notice lists them oldest first.
		const tags: Record<string, string> = {};
		for (const message of prompt) {
			const tagged = pairTagOf(message);
			if (tagged !== undefined) tags[tagged.callId] = tagged.tag;
		}
		const [oldestId, nextId] = Object.keys(tags);
		if (oldestId === undefined || nextId === undefined) throw new Error("the prompt pinned fewer than two pairs");
		const notices = nudgeIn(prompt);
		expect(notices).toHaveLength(1);
		expect(notices[0]!.content).toBe(`window oldest→newest: #${tags[oldestId]} read, #${tags[nextId]} read — oldest drop first as new results arrive`);

		// A resume re-derives from the branch and recomputes identical tags.
		const target = omp.session("s2", { branch: s.branch });
		await s.switchTo(target, "resume");
		const resumed = await target.step("next", { results: ["more"] });
		if (resumed === undefined) throw new Error("the resumed step returned no prompt");
		const resumedTagged: Array<{ callId: string; tag: string }> = [];
		for (const message of resumed) {
			const tagged = pairTagOf(message);
			if (tagged !== undefined) resumedTagged.push(tagged);
		}
		// The window pins both stored pairs and the resumed step's own result.
		expect(resumedTagged).toHaveLength(3);
		for (const tagged of resumedTagged) {
			if (tagged.callId in tags) expect(tags[tagged.callId]).toBe(tagged.tag);
		}
		const fresh = resumedTagged[2]!;
		expect(fresh.callId === oldestId || fresh.callId === nextId).toBe(false);
		const resumedNotices = nudgeIn(resumed);
		expect(resumedNotices).toHaveLength(1);
		expect(String(resumedNotices[0]!.content)).toBe(`window oldest→newest: #${tags[oldestId]} read, #${tags[nextId]} read, #${fresh.tag} read — oldest drop first as new results arrive`);
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
