import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { announcedSkillNames, consolidationNudgeMessage, extractStatePayload, fallbackNoticeMessage, isStateCoreMessage, isStateScratchMessage, OPERATING_RULES, RULES_MESSAGE_TYPE, SKILL_PROMPT_MESSAGE_TYPE, skillInvocationName, STATE_UPDATE_TOOL_NAME, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE, renderStateContent, skillAnnouncement, coreMessage, scratchMessage } from "../src/messages";

describe("consolidationNudgeMessage", () => {
	test("is a developer message asking for a state_update consolidation, with no fence, so it never becomes an elide target", () => {
		const nudge = consolidationNudgeMessage();
		expect(nudge).toEqual({
			role: "developer",
			content: expect.stringContaining("size cap"),
			timestamp: expect.any(Number),
		});
		if (!("content" in nudge) || typeof nudge.content !== "string") throw new Error("developer message without text content");
		expect(nudge.content).toContain(STATE_UPDATE_TOOL_NAME);
		expect(nudge.content.split("\n").some((line) => line.trimStart().startsWith("```"))).toBe(false);
	});
});

describe("fallbackNoticeMessage", () => {
	test("is a developer message naming the projection failure reason and the ordinary-context fallback", () => {
		const head = fallbackNoticeMessage("incomplete-head");
		expect(head).toEqual({
			role: "developer",
			content: expect.stringContaining("the stored head is incomplete"),
			timestamp: expect.any(Number),
		});
		if (!("content" in head) || typeof head.content !== "string") throw new Error("developer message without text content");
		expect(head.content).toContain("projection");

		const pair = fallbackNoticeMessage("unmatched-tool-pair");
		expect(pair).toEqual({
			role: "developer",
			content: expect.stringContaining("a tool result does not answer the tool call before it"),
			timestamp: expect.any(Number),
		});
		if (!("content" in pair) || typeof pair.content !== "string") throw new Error("developer message without text content");
		expect(pair.content).toContain("projection");
	});
});

describe("OPERATING_RULES", () => {
	test("names the state_update tool and carries no fence, so the stored rules message is never an elide target", () => {
		expect(OPERATING_RULES).toContain(STATE_UPDATE_TOOL_NAME);
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

describe("skillInvocationName", () => {
	test("names the invoked skill of a user-attributed skill-prompt, and nothing else", () => {
		expect(skillInvocationName({ customType: SKILL_PROMPT_MESSAGE_TYPE, attribution: "user", details: { name: "zstate" } })).toBe("zstate");
		expect(skillInvocationName({ customType: SKILL_PROMPT_MESSAGE_TYPE, attribution: "agent", details: { name: "zstate" } })).toBeUndefined();
		expect(skillInvocationName({ customType: STATE_CORE_MESSAGE_TYPE, attribution: "user", details: { name: "zstate" } })).toBeUndefined();
		expect(skillInvocationName({ customType: SKILL_PROMPT_MESSAGE_TYPE, attribution: "user" })).toBeUndefined();
		expect(skillInvocationName({ customType: SKILL_PROMPT_MESSAGE_TYPE, attribution: "user", details: { name: "" } })).toBeUndefined();
		expect(skillInvocationName({ customType: SKILL_PROMPT_MESSAGE_TYPE, attribution: "user", details: { name: 7 } })).toBeUndefined();
	});
});

// The announcement pair is pinned to the harness's user-invocation template;
// this guard fails loudly on a version bump instead of silently degrading
// detection to engage-at-message_end-only.
describe("the pinned harness announcement template", () => {
	test("the installed template's first line is still what skillAnnouncement renders and announcedSkillNames reads", () => {
		let dir = dirname(Bun.resolveSync("@oh-my-pi/pi-coding-agent", import.meta.dir));
		while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
		const first = readFileSync(join(dir, "src", "prompts", "skills", "user-invocation.md"), "utf8").split(/\r?\n/)[0]!;
		const rendered = first.replaceAll("{{name}}", "zstate");
		expect(rendered).toBe(skillAnnouncement("zstate"));
		expect(announcedSkillNames(rendered)).toEqual(["zstate"]);
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
