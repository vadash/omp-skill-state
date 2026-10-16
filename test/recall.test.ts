import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RECALL_CAP_MARKER, RECALL_RESULT_BYTES, recallTranscript, recallSession, renderRecall } from "../src/recall";
import { messageLine, titleSlotLine, transcriptStamp } from "./entries";

// The pure recall read (CONTEXT.md "Recall"): matches are the transcript's own
// text, verbatim, oldest first, under a byte cap; malformed lines never crash
// the read and a transcript with nothing to say is an empty result, not an
// error.

const customMessageLine = (content: string) => JSON.stringify({ type: "custom_message", customType: "skill-prompt", content, display: true, timestamp: transcriptStamp });

describe("recallTranscript", () => {
	test("an empty or blank transcript is an empty result, never an error", () => {
		expect(recallTranscript([], "crimson")).toEqual({ matches: [], truncated: false });
		expect(recallTranscript(["", "   ", "\t"], "crimson")).toEqual({ matches: [], truncated: false });
	});

	test("matches message text case-insensitively across every role", () => {
		const lines = [
			messageLine("user", "find the crimson report"),
			messageLine("assistant", [{ type: "text", text: "the CRIMSON report is filed" }]),
			messageLine("toolResult", [{ type: "text", text: "crimson bytes counted" }]),
			messageLine("assistant", [{ type: "text", text: "nothing relevant here" }]),
		];

		const { matches } = recallTranscript(lines, "CRIMSON");

		expect(matches).toEqual(["find the crimson report", "the CRIMSON report is filed", "crimson bytes counted"]);
	});

	test("matches skill-prompt custom messages and skips lines that carry no text", () => {
		const lines = [
			JSON.stringify({ type: "session", id: "s1", timestamp: transcriptStamp }),
			customMessageLine("skill body mentioning crimson rivers"),
			JSON.stringify({ type: "custom", customType: "sh.omp.skill-state.mirror", data: { core: { crimson: true }, scratch: {}, stamp: 1 } }),
			JSON.stringify({ type: "model_usage", timestamp: transcriptStamp }),
		];

		const { matches } = recallTranscript(lines, "crimson");

		expect(matches).toEqual(["skill body mentioning crimson rivers"]);
	});

	test("returns matches verbatim, in file order, with the query only deciding inclusion", () => {
		const first = "The Crimson Report, vol. 2 (annotated)";
		const second = "crimson report addendum: 12°C, rising";
		const lines = [messageLine("user", first), messageLine("assistant", "unrelated"), messageLine("user", second)];

		const { matches } = recallTranscript(lines, "crimson report");

		expect(matches).toEqual([first, second]);
	});

	test("the cap bounds the packed bytes and the separator counts against it", () => {
		const match = "m".repeat(100);
		const lines = [messageLine("user", match), messageLine("user", match)];

		// Two shown matches cost 100 + 2 + 100 = 202 bytes, one over this cap;
		// a pack that ignores the separator would show both.
		const { matches, truncated } = recallTranscript(lines, "m", 201);

		expect(matches).toEqual([match]);
		expect(Buffer.byteLength(matches.join("\n\n"))).toBeLessThanOrEqual(201);
		expect(truncated).toBe(true);
	});

	test("stops at the first match that would exceed the cap, so no later match is taken", () => {
		const big = "b".repeat(45);
		const lines = [messageLine("user", big), messageLine("user", "b tiny"), messageLine("user", "b x")];

		// The third match would fit exactly (45 + 2 + 3 = 50); the greedy pack
		// stops at the second and never reaches it.
		const { matches, truncated } = recallTranscript(lines, "b", 50);

		expect(matches).toEqual([big]);
		expect(truncated).toBe(true);
	});

	test("a truncated result is flagged so the exact cap marker is warranted", () => {
		const lines = [messageLine("user", "a".repeat(20_000)), messageLine("user", "a".repeat(20_000))];

		const { truncated } = recallTranscript(lines, "a");

		expect(truncated).toBe(true);
		expect(RECALL_RESULT_BYTES).toBe(16_384);
		expect(RECALL_CAP_MARKER).toBe("recall cap 16384 bytes reached — oldest matches shown; narrow the query to see the rest");
	});

	test("a result where everything fit carries no truncation", () => {
		const lines = [messageLine("user", "crimson"), messageLine("user", "crimson again")];

		const { matches, truncated } = recallTranscript(lines, "crimson");

		expect(matches).toHaveLength(2);
		expect(truncated).toBe(false);
	});

	test("the padded title slot and malformed lines are skipped, not crashes", () => {
		const lines = [
			titleSlotLine(),
			"{oops",
			'"a bare JSON string"',
			"null",
			messageLine("user", "crimson after the noise"),
		];

		const { matches, truncated } = recallTranscript(lines, "crimson");

		expect(matches).toEqual(["crimson after the noise"]);
		expect(truncated).toBe(false);
	});
});

describe("renderRecall", () => {
	test("a result that fit is the joined matches, no marker", () => {
		expect(renderRecall({ matches: ["first", "second"], truncated: false })).toBe("first\n\nsecond");
		expect(renderRecall({ matches: [], truncated: false })).toBe("");
	});

	test("a truncated result carries the exact cap marker after the joined matches", () => {
		expect(renderRecall({ matches: ["first", "second"], truncated: true })).toBe(`first\n\nsecond\n\n${RECALL_CAP_MARKER}`);
	});

	test("the marker rides outside the capped text, never counted into the pack", () => {
		const match = "m".repeat(100);
		// Two shown matches cost 100 + 2 + 100 = 202 bytes, one over this cap.
		const result = recallTranscript([messageLine("user", match), messageLine("user", match)], "m", 201);

		const rendered = renderRecall(result);
		const joined = result.matches.join("\n\n");

		expect(Buffer.byteLength(joined)).toBeLessThanOrEqual(201);
		expect(rendered.indexOf(RECALL_CAP_MARKER)).toBeGreaterThan(joined.length - 1);
	});

	test("a truncated result with nothing shown is the bare marker", () => {
		expect(renderRecall({ matches: [], truncated: true })).toBe(RECALL_CAP_MARKER);
	});
});

const root = await mkdtemp(path.join(tmpdir(), "recall-session-"));

describe("recallSession", () => {
	const jsonl = (name: string, lines: string[]) => {
		const file = path.join(root, name);
		writeFileSync(file, lines.join("\n") + "\n");
		return file;
	};

	afterAll(() => rm(root, { recursive: true, force: true }));

	test("a missing session file is an empty result, not an error", () => {
		expect(recallSession(path.join(root, "absent.jsonl"), "crimson")).toBe("");
	});

	test("no session file at all is an empty result", () => {
		expect(recallSession(undefined, "crimson")).toBe("");
	});

	test("a real transcript is matched verbatim, oldest first", () => {
		const file = jsonl("session.jsonl", [
			titleSlotLine(),
			messageLine("user", "find the crimson report"),
			"{oops",
			messageLine("assistant", "the CRIMSON report is filed"),
		]);

		expect(recallSession(file, "crimson")).toBe("find the crimson report\n\nthe CRIMSON report is filed");
	});

	test("any read failure other than a missing file propagates", () => {
		let error: unknown;
		try {
			recallSession(root, "crimson"); // a directory is not readable as a transcript file
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeDefined();
		// The exact errno differs per platform (EISDIR on the majors); what the
		// seam pins is that only a missing file reads as empty.
		expect((error as NodeJS.ErrnoException).code).not.toBe("ENOENT");
	});
});
