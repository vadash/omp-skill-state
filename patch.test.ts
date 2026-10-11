import { describe, expect, test } from "bun:test";
import { OPERATING_RULES, parsePatch, renderStateContent } from "./patch";

test("the operating rules and the parser agree", () => {
	expect(parsePatch(OPERATING_RULES)).toEqual({ kind: "json", value: { key: "value", obsolete: null } });
});

describe("parsePatch", () => {
	test("text with no state block is an empty patch", () => {
		expect(parsePatch("plain prose, no fences")).toEqual({ kind: "none" });
	});

	test("a json block is not a state patch", () => {
		expect(parsePatch('```json\n{"a":1}\n```')).toEqual({ kind: "none" });
	});

	test("a state block yields the parsed JSON value", () => {
		expect(parsePatch('```json state\n{"goal":"x"}\n```')).toEqual({ kind: "json", value: { goal: "x" } });
	});

	test("malformed JSON is an error mentioning valid JSON", () => {
		expect(parsePatch("```json state\n{ nope\n```")).toEqual({
			kind: "error",
			error: expect.stringContaining("valid JSON"),
		});
	});

	test("the first of two blocks wins", () => {
		const text = '```json state\n{"a":1}\n```\nmid\n```json state\n{"a":2}\n```';
		expect(parsePatch(text)).toEqual({ kind: "json", value: { a: 1 } });
	});

	test("a block among prose and tool-call chatter is found", () => {
		const text = 'I will read the file first.\n\n```json state\n{"goal":"x"}\n```\n\nNow calling tools.';
		expect(parsePatch(text)).toEqual({ kind: "json", value: { goal: "x" } });
	});

	test("CRLF line endings are tolerated", () => {
		expect(parsePatch('```json state\r\n{"goal":"x"}\r\n```')).toEqual({ kind: "json", value: { goal: "x" } });
	});
});

describe("renderStateContent", () => {
	test("renders the state as labelled plain JSON: no fence line, so the harness's elide pass never targets it, and never a patch", () => {
		const content = renderStateContent({ a: 1 });
		expect(content.split("\n").some((line) => line.trimStart().startsWith("```"))).toBe(false);
		expect(content).toContain(JSON.stringify({ a: 1 }, null, 2));
		expect(parsePatch(content)).toEqual({ kind: "none" });
	});
});
