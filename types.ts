import type { ContextEvent } from "@oh-my-pi/pi-coding-agent";

// The harness's transcript message union, taken from the context event payload:
// the published package's root entry exports ContextEvent but not AgentMessage.
// Its own module because messages.ts and projection.ts both need it, and one
// importing the other would close an import cycle.
export type AgentMessage = ContextEvent["messages"][number];
