import { afterAll, describe, expect, jest, test } from "bun:test";
import { rm } from "node:fs/promises";
import { STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE, STATE_UPDATE_DESCRIPTION, STATE_UPDATE_TOOL_NAME, coreMessage, renderStateContent } from "../src/messages";
import type { ExecutionState } from "../src/state";
import { fakeOmp } from "./fake-session";
import type { FakeOmp } from "./fake-session";
import { disengageNotices, engagedSession, engageAsideTypes, engageNotices, makeSkillSet, patchStep, procedureSchema, stateSends } from "./harness";

const fx = await makeSkillSet({ procedure: JSON.stringify(procedureSchema) });
afterAll(() => rm(fx.root, { recursive: true, force: true }));
const { procedure } = fx.skills;

describe("omp-skill-state patch loop", () => {
	// Renders a state message through the adapter's registered renderer, as
	// the transcript UI would.
	function stateLine(omp: FakeOmp, type: string, expanded: boolean, state: ExecutionState) {
		const theme = { fg: (_color: string, text: string) => text };
		const renderer = omp.renderers.get(type) as
			| ((message: unknown, options: { expanded: boolean }, theme: unknown) => { getText(): string })
			| undefined;
		if (renderer === undefined) throw new Error(`no renderer registered for ${type}`);
		return renderer({ role: "custom", customType: type, content: renderStateContent(state), display: true, details: { state }, timestamp: Date.now() }, { expanded }, theme).getText();
	}

	test("the renderers show keys collapsed and pretty JSON expanded, never the raw one-liner", () => {
		const omp = fakeOmp([procedure]);
		for (const type of [STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE]) {
			const collapsed = stateLine(omp, type, false, { goal: "g" });
			expect(collapsed).toContain("goal");
			expect(collapsed).not.toContain('{"goal":"g"}');

			const expanded = stateLine(omp, type, true, { goal: "g" });
			expect(expanded).toContain('"goal": "g"');
		}
	});

	// With an empty state both partitions collapse to the same text, which read
	// as one notify printed twice (2026-10-12 zstate run); the label must say
	// which partition a line carries.
	test("the collapsed labels name the partition, so core and scratch never render identically", () => {
		const omp = fakeOmp([procedure]);

		expect(stateLine(omp, STATE_CORE_MESSAGE_TYPE, false, { goal: "g" })).toContain("core");
		expect(stateLine(omp, STATE_SCRATCH_MESSAGE_TYPE, false, { goal: "g" })).toContain("scratch");
		// The empty-state case: both partitions are {} yet the lines must differ.
		expect(stateLine(omp, STATE_CORE_MESSAGE_TYPE, false, {})).not.toBe(stateLine(omp, STATE_SCRATCH_MESSAGE_TYPE, false, {}));
	});

	test("no state_update call is an empty patch: nothing sent, tool calls run", async () => {
		const { s } = await engagedSession([procedure]);

		await s.step("Prose only, calling a tool.");

		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);
		expect(s.blocked).toEqual([]);
	});

	test("a valid state_update call commits the patch and the core+scratch asides land at the step boundary", async () => {
		const { s } = await engagedSession([procedure]);

		await s.step("recording", patchStep({ goal: "x" }));

		expect(s.sends).toHaveLength(6);
		expect(s.sends.slice(4)).toEqual(stateSends({ goal: "x" }, "aside"));
		expect(s.blocked).toEqual([]);
		// Stored at the step boundary, before the next provider call.
		expect(s.storedStates).toEqual([{}, { goal: "x" }]);
	});

	test("an invalid patch blocks every call of the batch, the state_update call included, with the exact validation error", async () => {
		const { s } = await engagedSession([procedure]);

		await s.step("recording", patchStep({ goal: 42 }, ["read", "bash"]));

		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);
		expect(s.blocked.map((call) => call.toolName)).toEqual([STATE_UPDATE_TOOL_NAME, "read", "bash"]);
		for (const call of s.blocked) expect(call.reason).toBe('state key "goal" must be a string (was number)');
	});

	test("a state_update call without a patch argument blocks with the shape error", async () => {
		const { s } = await engagedSession([procedure]);

		await s.step("recording", { tools: [STATE_UPDATE_TOOL_NAME] });

		expect(s.blocked.map((call) => call.toolName)).toEqual([STATE_UPDATE_TOOL_NAME]);
		expect(s.blocked[0]!.reason).toBe("state patch must be a JSON object");
	});

	test("the third consecutive invalid patch degrades and the session runs ordinarily", async () => {
		const { omp, s } = await engagedSession([procedure]);

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
	});

	test("agent_end settles the live state as next-turn core and scratch once the session is idle", async () => {
		const { s } = await engagedSession([procedure]);
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
		const { s } = await engagedSession([procedure]);
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
		const { s } = await engagedSession([procedure]);
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
