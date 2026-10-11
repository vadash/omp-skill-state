import { describe, expect, test } from "bun:test";
import { STATE_MESSAGE_TYPE, renderStateContent, stateMessage } from "./messages";
import { parsePatch } from "./patch";

describe("renderStateContent", () => {
	test("renders the state as labelled plain JSON: no fence line, so the harness's elide pass never targets it, and never a patch", () => {
		const content = renderStateContent({ a: 1 });
		expect(content.split("\n").some((line) => line.trimStart().startsWith("```"))).toBe(false);
		expect(content).toContain(JSON.stringify({ a: 1 }, null, 2));
		expect(parsePatch(content)).toEqual({ kind: "none" });
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
