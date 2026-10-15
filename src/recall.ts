import { contentText } from "./branch";
import { isPlainObject } from "./types";

// Recall (CONTEXT.md) reads the transcript's own text back verbatim; the cap
// bounds the packed matches only. The marker that names a truncation rides
// after the packed matches and is never counted out of existence.
export const RECALL_RESULT_BYTES = 16_384;

export const RECALL_CAP_MARKER = `recall cap ${RECALL_RESULT_BYTES} bytes reached — oldest matches shown; narrow the query to see the rest`;

export interface RecallResult {
	matches: string[];
	truncated: boolean;
}

const SHOWN_SEPARATOR = "\n\n";

// Entry text is the transcript's own text: message entries of every role and
// text-bearing custom_message entries (skill prompts). Title slots, session
// headers, mirrors and other no-text lines yield "" and are skipped.
function entryText(entry: unknown): string {
	if (!isPlainObject(entry)) return "";
	if (entry.type === "message" && isPlainObject(entry.message)) return blockText(entry.message.content);
	if (entry.type === "custom_message") return blockText(entry.content);
	return "";
}

function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return contentText(content);
	return "";
}

// Pure recall over the transcript's JSONL lines: case-insensitive substring
// matches in file order, greedily packed oldest-first under the byte cap.
// Malformed lines are skipped, never errors. The first match that would
// overflow the cap ends the pack, so no later match is considered; any
// unpicked match flags the result truncated.
export function recallTranscript(lines: string[], query: string, capBytes: number = RECALL_RESULT_BYTES): RecallResult {
	const needle = query.toLowerCase();
	const matches: string[] = [];
	let used = 0;
	let truncated = false;
	for (const line of lines) {
		if (line.trim() === "") continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const text = entryText(entry);
		if (text === "" || !text.toLowerCase().includes(needle)) continue;
		const cost = (used > 0 ? SHOWN_SEPARATOR.length : 0) + Buffer.byteLength(text);
		if (used + cost > capBytes) {
			truncated = true;
			break;
		}
		used += cost;
		matches.push(text);
	}
	return { matches, truncated };
}
