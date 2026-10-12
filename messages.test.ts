import { describe, expect, test } from "bun:test";
import { announcedSkillNames, OPERATING_RULES, RULES_MESSAGE_TYPE, STATE_MESSAGE_TYPE, renderStateContent, skillAnnouncement, stateMessage } from "./messages";

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

describe("stateMessage", () => {
	test("carries the rendered state and details.state for re-derive", () => {
		expect(stateMessage({ goal: "x" })).toEqual({
			customType: STATE_MESSAGE_TYPE,
			content: renderStateContent({ goal: "x" }),
			display: true,
			details: { state: { goal: "x" } },
		});
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
