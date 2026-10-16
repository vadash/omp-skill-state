import { describe, expect, test } from "bun:test";
import { contentText } from "../src/types";

describe("contentText", () => {
	test("a string passes through", () => {
		expect(contentText("body")).toBe("body");
	});

	test("text blocks join with newlines and other blocks are skipped", () => {
		const blocks = [{ type: "text", text: "a" }, { type: "image", data: "x", mimeType: "image/png" }, { type: "text", text: "b" }];

		expect(contentText(blocks)).toBe("a\nb");
	});

	test("anything else is stringified", () => {
		expect(contentText(42)).toBe("42");
	});
});
