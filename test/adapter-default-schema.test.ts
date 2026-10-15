import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { parseStateSchema } from "../src/state";
import { fakeOmp } from "./fake-session";
import { engagedSession, engageAsideTypes, engageNotices, makeSkillSet, patchStep, stateSends } from "./harness";

const fx = await makeSkillSet({ defaults: JSON.stringify({ type: "object" }) });
afterAll(() => rm(fx.root, { recursive: true, force: true }));
const defaults = fx.skills.defaults!;

const selected = parseStateSchema({ type: "object" });
if (!selected.ok) throw new Error("the default-schema marker failed to parse");

describe("omp-skill-state default-schema selection", () => {
	test("a marker with no properties engages and the run works on the default keys", async () => {
		const { s } = await engagedSession([defaults]);

		expect(s.notices).toEqual(engageNotices("defaults"));
		expect(s.sends.map((sent) => sent.payload.customType)).toEqual(engageAsideTypes);

		const patch = { goal: "land the fix", knowledge: { port: 8080 }, plan: ["write tests"] };
		await s.step("recording", patchStep(patch));

		expect(s.blocked).toEqual([]);
		expect(s.sends.slice(4)).toEqual(stateSends(patch, "aside", selected.schema));
		expect(s.storedStates).toEqual([{}, patch]);
	});

	test("the commit's core carries goal and the knowledge bag, the scratch the plan", async () => {
		const { s } = await engagedSession([defaults]);

		await s.step("recording", patchStep({ goal: "land the fix", knowledge: { port: 8080 }, plan: ["write tests"] }));

		expect(s.sends[4]?.payload.details).toEqual({ state: { goal: "land the fix", knowledge: { port: 8080 } } });
		expect(s.sends[5]?.payload.details).toEqual({ state: { plan: ["write tests"] } });
	});

	test("a model skill read of the schema-less marker stays inert", async () => {
		const s = fakeOmp([defaults]).session("s1");
		await s.endMessage({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [{ type: "text", text: "skill://defaults/state.schema.json" }],
			isError: false,
			timestamp: Date.now(),
		});

		expect(s.notices).toEqual([]);
	});
});
