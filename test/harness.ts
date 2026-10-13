import { expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { PROCEDURE_SPEC_MESSAGE_TYPE, RULES_MESSAGE_TYPE, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE, STATE_UPDATE_TOOL_NAME, coreMessage, scratchMessage } from "../src/messages";
import { splitState } from "../src/state";
import type { ExecutionState, StateSchema } from "../src/state";
import { fakeOmp } from "./fake-session";
import { makeSkill } from "./skill-fixtures";

// The adapter suites' shared harness: fixtures, the two session builders and
// the assertion builders every suite reads the fake through. One interface,
// so a change to the fake-harness idioms lands here and nowhere else.

// Engage sends exactly these four asides; the patch loop must add nothing else.
export const engageAsideTypes = [RULES_MESSAGE_TYPE, PROCEDURE_SPEC_MESSAGE_TYPE, STATE_CORE_MESSAGE_TYPE, STATE_SCRATCH_MESSAGE_TYPE];

// The `procedure` skill's schema declares only `goal`, so `goal` lands
// in the state core and every other key in the scratch state.
export const procedureSchema: StateSchema = { type: "object", properties: { goal: { type: "string" } } };

// A goal-only state with a 300-byte observation cap, for the projection suite
// that needs truncation on real step results.
export const smallcapSchema = { type: "object", properties: { goal: { type: "string" } }, "x-state": { observationBytes: 300 } };

// One tmpdir of skills per suite file: bun isolates files, and each suite
// builds only the skills its claims need. Cleanup is the suite's afterAll.
export async function makeSkillSet(specs: Record<string, string | undefined>): Promise<{ root: string; skills: Record<string, Skill> }> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-skill-state-"));
	const skills: Record<string, Skill> = {};
	for (const [name, schema] of Object.entries(specs)) skills[name] = await makeSkill(root, name, schema);
	return { root, skills };
}

// A session that has invoked its first skill: engaged, head asides pending
// until the first step boundary.
export async function engagedSession(skills: Skill[], id = "s1") {
	const omp = fakeOmp(skills);
	const s = omp.session(id);
	await s.invoke(skills[0]!.name);
	return { omp, s };
}

// An engaged session whose first step has landed the head, so every step
// after it carries a projected prompt. The first step after engage runs
// before the head asides land, so its prompt is not projected, never counts
// as idle (spec section 11.4) and carries exactly one fallback notice.
export async function projectingSession(skill: Skill, id = "s1") {
	const omp = fakeOmp([skill]);
	const s = omp.session(id);
	await s.invoke(skill.name);
	const first = await s.step("the first step lands the head");
	if (first === undefined) throw new Error("the first step returned no prompt");
	expect(nudgeIn(first)).toHaveLength(1);
	return { omp, s };
}

// The two stored state messages a commit sends, in order, as the fake records
// them.
export const stateSends = (state: ExecutionState, deliverAs: "aside" | "nextTurn") => {
	const { core, scratch } = splitState(state, procedureSchema);
	return [
		{ payload: coreMessage(core) as Record<string, unknown>, options: { deliverAs } },
		{ payload: scratchMessage(scratch) as Record<string, unknown>, options: { deliverAs } },
	];
};

// The step options for a reply whose batch calls state_update with a patch,
// optionally alongside extra tools.
export const patchStep = (patch: unknown, extraTools: string[] = []) => ({
	tools: [STATE_UPDATE_TOOL_NAME, ...extraTools],
	arguments: [{ patch }, ...extraTools.map(() => ({}))],
});

// The developer messages a returned prompt carries: the per-call nudges on a
// projected step, the fallback notice on an unprojected one.
export function nudgeIn(prompt: unknown[] | undefined): { role: unknown; content: unknown }[] {
	const nudges: { role: unknown; content: unknown }[] = [];
	for (const message of prompt ?? []) {
		if (typeof message === "object" && message !== null && "role" in message && "content" in message && message.role === "developer") {
			nudges.push(message);
		}
	}
	return nudges;
}

export const engageNotices = (name: string) => [
	{ message: `skill-state: procedure "${name}" engaged`, type: "info" },
	{ message: "skill-state: history is hidden from the model while engaged; finish with /new", type: "info" },
];

export const disengageNotices = (name: string, trigger: string) => [
	{ message: `skill-state: procedure "${name}" disengaged (${trigger})`, type: "info" },
];
