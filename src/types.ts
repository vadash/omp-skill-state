import type { ContextEvent } from "@oh-my-pi/pi-coding-agent";

// The harness's transcript message union, taken from the context event payload:
// the published package's root entry exports ContextEvent but not AgentMessage.
// Its own module because messages.ts and projection.ts both need it, and one
// importing the other would close an import cycle.
export type AgentMessage = ContextEvent["messages"][number];

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Why the projection fell back to ordinary context: the stored head is
// incomplete, or the newest tool pair cannot be matched to its assistant
// message. project returns one of these instead of a projected prompt.
export type ProjectionFailure = "incomplete-head" | "unmatched-tool-pair";
