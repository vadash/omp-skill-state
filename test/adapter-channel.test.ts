import { afterAll, describe, expect, jest, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { RECALL_CAP_MARKER, RECALL_RESULT_BYTES } from "../src/recall";
import { STATE_CORE_MESSAGE_TYPE, STATE_MIRROR_ENTRY_TYPE, STATE_RECALL_DESCRIPTION, STATE_RECALL_TOOL_NAME, STATE_SCRATCH_MESSAGE_TYPE, STATE_UPDATE_DESCRIPTION, STATE_UPDATE_TOOL_NAME, coreMessage, renderStateContent } from "../src/messages";
import { newProcedure, recordReply } from "../src/procedure";
import { DEFAULT_PARAMS } from "../src/state";
import type { ExecutionState } from "../src/state";
import { messageLine, titleSlotLine, transcriptStamp } from "./entries";
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
		expect(s.sends.slice(4)).toEqual(stateSends({ goal: "x" }, "aside", 1));
		expect(s.blocked).toEqual([]);
		// Stored at the step boundary, before the next provider call.
		expect(s.storedStates).toEqual([{}, { goal: "x" }]);
	});

	test("every accepted commit appends a mirror entry with the same partitions and stamp, ahead of its pair", async () => {
		const { s } = await engagedSession([procedure]);

		await s.step("first", patchStep({ goal: "x" }));
		await s.step("second", patchStep({ note: "y" }));
		// An empty patch is no commit: no mirror, no send.
		await s.step("idle", patchStep({ goal: "x" }));

		expect(s.mirrors).toEqual([
			{ core: { goal: "x" }, scratch: {}, stamp: 1 },
			{ core: { goal: "x" }, scratch: { note: "y" }, stamp: 2 },
		]);
		// The durable record lands during the execute, the pair flushes at the
		// step boundary, so each mirror entry sits before its own pair.
		const positions = s.branch.map((entry) => (entry.type === "custom" && entry.customType === STATE_MIRROR_ENTRY_TYPE ? "mirror" : entry.type === "custom_message" && (entry.customType === STATE_CORE_MESSAGE_TYPE || entry.customType === STATE_SCRATCH_MESSAGE_TYPE) ? "state" : "other"));
		expect(positions.indexOf("mirror")).toBeLessThan(positions.indexOf("state"));
		expect(positions.lastIndexOf("mirror")).toBeLessThan(positions.lastIndexOf("state"));
	});

	test("the mirror never reaches the model: it is entry data, in no send and no prompt", async () => {
		const { s } = await engagedSession([procedure]);

		await s.step("recording", patchStep({ goal: "x" }));

		expect(s.sends.map((sent) => sent.payload.customType)).not.toContain(STATE_MIRROR_ENTRY_TYPE);
		for (const prompt of s.prompts) {
			for (const message of prompt ?? []) {
				if (typeof message === "object" && message !== null && "customType" in message) {
					expect(message.customType).not.toBe(STATE_MIRROR_ENTRY_TYPE);
				}
			}
		}
		// The harness's appendEntry writes a custom entry, not a message, and
		// the fake's branch conversion never turns one into a prompt message.
		expect(s.branch.filter((entry) => entry.type === "custom")).toHaveLength(1);
	});

	test("an invalid patch blocks every call of the batch, the state_update call included, with the exact validation error", async () => {
		const { s } = await engagedSession([procedure]);

		await s.step("recording", patchStep({ goal: 42 }, ["read", "bash"]));

		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);
		expect(s.blocked.map((call) => call.toolName)).toEqual([STATE_UPDATE_TOOL_NAME, "read", "bash"]);
		for (const call of s.blocked) expect(call.reason).toBe('state key "goal" must be a string (was number)');
	});

	test("a reply carrying two valid patches commits both, in declaration order, landing on one fold of the two", async () => {
		const { s } = await engagedSession([procedure]);
		// Parked on goal "z" so the two patches y then z fold and commit back
		// to where they started: the fold leaves the record's own state
		// untouched, which is what makes it comparable to the commits' landing.
		await s.step("parking", patchStep({ goal: "z" }));

		// The fold witness: the same two patches folded once by the step
		// policy, on a twin procedure over the same schema and the same
		// parked state.
		const fold = newProcedure("procedure", "invoked", procedureSchema, DEFAULT_PARAMS, { goal: "z" });
		expect(recordReply(fold, { patches: [{ goal: "y" }, { goal: "z" }], hasPatch: true })).toEqual({ kind: "ok" });

		await s.step("recording", { tools: [STATE_UPDATE_TOOL_NAME, STATE_UPDATE_TOOL_NAME], arguments: [{ patch: { goal: "y" } }, { patch: { goal: "z" } }] });

		// One commit per patch, in declaration order: the second patch lands
		// against the state the first commit left (re-reading the parked state
		// instead would make z no change: no commit, no send).
		expect(s.storedStates).toEqual([{}, { goal: "z" }, { goal: "y" }, { goal: "z" }]);
		expect(s.sends.slice(6)).toEqual([...stateSends({ goal: "y" }, "aside", 2), ...stateSends({ goal: "z" }, "aside", 3)]);
		// One mirror per accepted patch, in commit order.
		expect(s.mirrors.slice(1)).toEqual([
			{ core: { goal: "y" }, scratch: {}, stamp: 2 },
			{ core: { goal: "z" }, scratch: {}, stamp: 3 },
		]);
		expect(s.blocked).toEqual([]);
		// The commits land where the one fold landed (CONTEXT.md "Fold"/"Commit" equivalence).
		expect(s.storedStates.at(-1)).toEqual(fold.state);
	});

	test("a reply whose second patch is invalid commits nothing and blocks the whole batch", async () => {
		const { s } = await engagedSession([procedure]);

		await s.step("recording", { tools: [STATE_UPDATE_TOOL_NAME, STATE_UPDATE_TOOL_NAME], arguments: [{ patch: { goal: "y" } }, { patch: { goal: 42 } }] });

		// The fold refused the step, so the tool_call handler blocks every
		// call and no execute runs: nothing commits, nothing sends.
		expect(s.blocked.map((call) => call.toolName)).toEqual([STATE_UPDATE_TOOL_NAME, STATE_UPDATE_TOOL_NAME]);
		for (const call of s.blocked) expect(call.reason).toBe('state key "goal" must be a string (was number)');
		expect(s.storedStates).toEqual([{}]);
		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);
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
			expect(s.sends.slice(6)).toEqual(stateSends({ goal: "x" }, "nextTurn", 1));
			// Idle delivery lands on the branch at once, without a turn.
			expect(s.storedStates.at(-1)).toEqual({ goal: "x" });

			// A later run end settles the live state again: agent_end always
			// snapshots procedure.state.
			await s.step("again", { tools: [] });
			expect(s.sends.slice(8)).toEqual(stateSends({ goal: "x" }, "nextTurn", 1));
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
			expect(s.sends[4]!.payload).toEqual(coreMessage({ goal: "y" }, 1) as Record<string, unknown>);

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

	test("the definition declares exclusive scheduling: one reply's state_update calls run one at a time, in declaration order (spec section 8)", async () => {
		const omp = fakeOmp([procedure]);

		// concurrency is not on the extension-facing ToolDefinition type; it
		// reaches the harness scheduler as a forwarded extra property, the
		// untyped surface this assertion pins.
		const def = omp.tool(STATE_UPDATE_TOOL_NAME)! as { concurrency?: unknown };

		expect(def.concurrency).toBe("exclusive");
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
		expect(s.sends.slice(4)).toEqual(stateSends({ goal: "x" }, "aside", 1));
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

describe("omp-skill-state state_recall registration", () => {
	// A real transcript file under the suite's fixture root; the suite's
	// afterAll cleans it up with the skills.
	const jsonl = (name: string, lines: string[]) => {
		const file = path.join(fx.root, name);
		writeFileSync(file, lines.join("\n") + "\n");
		return file;
	};

	test("registers the pinned definition at factory load, before any engage", async () => {
		const omp = fakeOmp([procedure]);
		const def = omp.tool(STATE_RECALL_TOOL_NAME)!;
		expect(def.name).toBe(STATE_RECALL_TOOL_NAME);
		expect(def.description).toBe(STATE_RECALL_DESCRIPTION);
		expect(def.strict).toBe(true);
		// Zero approval like the patch channel: a recall read never prompts.
		expect(def.approval).toEqual({ tier: "read", policy: "allow" });
		// The wrapper: exactly one query argument.
		const parameters = def.parameters as { parse(value: unknown): unknown };
		expect(parameters.parse({ query: "crimson" })).toEqual({ query: "crimson" });
		expect(() => parameters.parse({})).toThrow();
		expect(() => parameters.parse({ query: 3 })).toThrow();
		expect(() => parameters.parse({ patch: {} })).toThrow();

		// Registration is permanent: an engage adds nothing new.
		await omp.session("s1").invoke("procedure");
		expect(omp.tool(STATE_RECALL_TOOL_NAME)).toBe(def);
	});

	test("requests top-level presentation like the patch channel: the query travels as protocol-level JSON", async () => {
		const omp = fakeOmp([procedure]);

		await omp.session("s1").invoke("procedure");

		expect(omp.tool(STATE_RECALL_TOOL_NAME)!.loadMode).toBe("essential");
	});

	test("declares exclusive scheduling like the patch channel", async () => {
		const omp = fakeOmp([procedure]);

		// Not on the extension-facing type; reaches the scheduler as a
		// forwarded extra property, the untyped surface this assertion pins.
		const def = omp.tool(STATE_RECALL_TOOL_NAME)! as { concurrency?: unknown };

		expect(def.concurrency).toBe("exclusive");
	});

	test("a direct execute reads matching text back verbatim, oldest first, from the session's own transcript", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		s.sessionFile = jsonl("recall-verbatim.jsonl", [
			titleSlotLine(),
			JSON.stringify({ type: "session", id: "s1", timestamp: transcriptStamp }),
			messageLine("user", "find the crimson report"),
			messageLine("assistant", [{ type: "text", text: "the CRIMSON report is filed" }]),
			messageLine("toolResult", [{ type: "text", text: "crimson bytes counted" }]),
			JSON.stringify({ type: "custom", customType: "sh.omp.skill-state.mirror", data: { core: {}, scratch: {}, stamp: 1 } }),
			"{oops",
		]);
		const def = omp.tool(STATE_RECALL_TOOL_NAME)!;

		const result = await def.execute("t1", { query: "CRIMSON" }, undefined, undefined, s.ctx());

		// Matches only: no-text and malformed lines are skipped, the padded
		// title slot parses, every match is the file's own text in file order,
		// and nothing was dropped so no marker rides.
		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "find the crimson report\n\nthe CRIMSON report is filed\n\ncrimson bytes counted" }]);
	});

	test("a transcript whose matches overflow the cap truncates with the exact marker", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		const chunk = "c".repeat(6000);
		const shown = `crimson ${chunk}`;
		s.sessionFile = jsonl("recall-oversized.jsonl", [
			titleSlotLine(),
			messageLine("user", shown),
			messageLine("user", shown),
			messageLine("user", shown),
		]);
		const def = omp.tool(STATE_RECALL_TOOL_NAME)!;

		const result = await def.execute("t1", { query: "crimson" }, undefined, undefined, s.ctx());

		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: `${shown}\n\n${shown}\n\nrecall cap 16384 bytes reached — oldest matches shown; narrow the query to see the rest` }]);
		// The marker rides after the packed matches, outside the cap.
		const text = (result.content as Array<{ type: string; text?: string }>)[0]!.text!;
		expect(Buffer.byteLength(text.slice(0, text.length - RECALL_CAP_MARKER.length - 2))).toBeLessThanOrEqual(RECALL_RESULT_BYTES);
	});

	test("a transcript file that is missing on disk yields an empty non-error result", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		s.sessionFile = path.join(fx.root, "absent-transcript.jsonl");
		const def = omp.tool(STATE_RECALL_TOOL_NAME)!;

		const result = await def.execute("t1", { query: "crimson" }, undefined, undefined, s.ctx());

		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "" }]);
	});

	test("no transcript file at all yields an empty non-error result, never a cross-session read", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		const def = omp.tool(STATE_RECALL_TOOL_NAME)!;

		const result = await def.execute("t1", { query: "crimson" }, undefined, undefined, s.ctx());

		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "" }]);
	});

	test("a transcript with no matching lines yields an empty non-error result", async () => {
		const omp = fakeOmp([procedure]);
		const s = omp.session("s1");
		s.sessionFile = jsonl("recall-quiet.jsonl", [titleSlotLine(), messageLine("user", "nothing to see here")]);
		const def = omp.tool(STATE_RECALL_TOOL_NAME)!;

		const result = await def.execute("t1", { query: "crimson" }, undefined, undefined, s.ctx());

		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "" }]);
	});
});
