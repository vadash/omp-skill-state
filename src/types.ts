import type { ContextEvent } from "@oh-my-pi/pi-coding-agent";

// The harness's transcript message union, taken from the context event payload:
// the published package's root entry exports ContextEvent but not AgentMessage.
// Its own module because branch.ts, procedure.ts and projection.ts all need
// it, and one importing the other would close an import cycle.
export type AgentMessage = ContextEvent["messages"][number];

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Custom message content is a string or text blocks; the invocation's P is
// taken from and the stored P is read back through the same path. Shared by
// the branch scan and the adapter's P read-back, so it lives on the leaf.
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.flatMap((block) => (isPlainObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
			.join("\n");
	}
	return String(content);
}

// Why the projection fell back to ordinary context: the stored head is
// incomplete. This is the only fallback reason, because an empty tail behind
// an intact head degrades in place instead (ADR 0010). project returns it
// instead of a projected prompt.
export type ProjectionFailure = "incomplete-head";

// One tailed tool result's window-notice data: its pair tag and tool name,
// collected oldest first (issue #52). Shared by the projection's result and
// the window-notice builder in procedure.ts; the projection must not import
// procedure.ts.
export interface TailedResultPair {
	tag: string;
	toolName: string;
}
