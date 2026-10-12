import { describe, expect, test } from "bun:test";
import { announcedSkillNames, consolidationNudgeMessage, extractStatePayload, isStateCoreMessage, isStateScratchMessage, OPERATING_RULES, RULES_MESSAGE_TYPE, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE, renderStateContent, skillAnnouncement, coreMessage, scratchMessage } from "./messages";

describe("consolidationNudgeMessage", () => {
	test("is a developer message asking for a state_update consolidation, with no fence, so it never becomes an elide target", () => {
		const nudge = consolidationNudgeMessage();
		expect(nudge).toEqual({
			role: "developer",
			content: expect.stringContaining("size cap"),
			timestamp: expect.any(Number),
		});
		if (!("content" in nudge) || typeof nudge.content !== "string") throw new Error("developer message without text content");
		expect(nudge.content).toContain("state_update");
		expect(nudge.content.split("\n").some((line) => line.trimStart().startsWith("```"))).toBe(false);
	});
});

describe("OPERATING_RULES", () => {
	test("names the state_update tool and carries no fence, so the stored rules message is never an elide target", () => {
		expect(OPERATING_RULES).toContain("state_update");
		expect(OPERATING_RULES.split("\n").some((line) => line.trimStart().startsWith("```"))).toBe(false);
	});
});

describe("renderStateContent", () => {
	test("renders the state as labelled plain JSON: no fence line, so the harness's elide pass never targets it", () => {
		const content = renderStateContent({ a: 1 });
		expect(content.split("\n").some((line) => line.trimStart().startsWith("```"))).toBe(false);
		expect(content).toContain(JSON.stringify({ a: 1 }, null, 2));
	});
});

describe("coreMessage", () => {
	test("carries the rendered core partition and details.state for re-derive", () => {
		expect(coreMessage({ goal: "x" })).toEqual({
			customType: STATE_CORE_MESSAGE_TYPE,
			content: renderStateContent({ goal: "x" }),
			display: true,
			details: { state: { goal: "x" } },
		});
	});
});

describe("scratchMessage", () => {
	test("carries the rendered scratch partition and details.state for re-derive", () => {
		expect(scratchMessage({ plan: ["a"] })).toEqual({
			customType: STATE_SCRATCH_MESSAGE_TYPE,
			content: renderStateContent({ plan: ["a"] }),
			display: true,
			details: { state: { plan: ["a"] } },
		});
	});

	test("an empty scratch renders as a stored empty-object message", () => {
		expect(scratchMessage({})).toEqual({ customType: STATE_SCRATCH_MESSAGE_TYPE, content: renderStateContent({}), display: true, details: { state: {} } });
		expect(coreMessage({})).toEqual({ customType: STATE_CORE_MESSAGE_TYPE, content: renderStateContent({}), display: true, details: { state: {} } });
	});
});

describe("skillAnnouncement / announcedSkillNames", () => {
	test("round-trips the harness announcement line", () => {
		expect(skillAnnouncement("zstate")).toBe('[IMPORTANT: User invoked the "zstate" skill; follow its instructions. Full skill below.]');
		expect(announcedSkillNames(skillAnnouncement("zstate") + "\n\nbody")).toEqual(["zstate"]);
	});

	test("finds no name without an announcement", () => {
		expect(announcedSkillNames("ordinary prompt text")).toEqual([]);
	});

	test("finds every announced name in a joined batch, in order", () => {
		const prompt = `${skillAnnouncement("alpha")}\n\n${skillAnnouncement("beta")}\nbody`;
		expect(announcedSkillNames(prompt)).toEqual(["alpha", "beta"]);
	});
});

describe("state message predicates", () => {
	test("tells the two partitions apart", () => {
		expect(isStateCoreMessage({ customType: STATE_CORE_MESSAGE_TYPE })).toBe(true);
		expect(isStateCoreMessage({ customType: STATE_SCRATCH_MESSAGE_TYPE })).toBe(false);
		expect(isStateCoreMessage({})).toBe(false);
		expect(isStateScratchMessage({ customType: STATE_SCRATCH_MESSAGE_TYPE })).toBe(true);
		expect(isStateScratchMessage({ customType: "skill-prompt" })).toBe(false);
	});

	test("extractStatePayload reads only this runtime's payload shape", () => {
		expect(extractStatePayload({ state: { goal: "x" } })).toEqual({ goal: "x" });
		expect(extractStatePayload({ state: "junk" })).toBeUndefined();
		expect(extractStatePayload({})).toBeUndefined();
		expect(extractStatePayload(undefined)).toBeUndefined();
		expect(extractStatePayload("nope")).toBeUndefined();
	});
});
