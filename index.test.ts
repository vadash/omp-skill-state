import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import extension from "./index";

type SessionStartHandler = (event: unknown, ctx: unknown) => unknown;

function recordingPi() {
	const events: string[] = [];
	const handlers = new Map<string, SessionStartHandler>();
	const pi = {
		on(event: string, handler: SessionStartHandler) {
			events.push(event);
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	return { pi, events, handlers };
}

function captureSessionStart(): SessionStartHandler {
	const { pi, handlers } = recordingPi();
	extension(pi);
	const handler = handlers.get("session_start");
	if (!handler) throw new Error("factory did not register a session_start handler");
	return handler;
}

function mockCtx(agentKind: "main" | "sub") {
	const notified: Array<{ message: string; type?: string }> = [];
	const ctx = {
		agent: { kind: agentKind },
		ui: {
			notify(message: string, type?: string) {
				notified.push({ message, type });
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, notified };
}

describe("omp-skill-state extension factory", () => {
	test("is a factory function, as the loader contract requires", () => {
		expect(typeof extension).toBe("function");
	});

	test("registers exactly one handler, for session_start, and nothing else", () => {
		const { pi, events } = recordingPi();

		extension(pi);

		expect(events).toEqual(["session_start"]);
	});

	test("notifies once, on one line, at main-agent session_start", async () => {
		const handler = captureSessionStart();
		const { ctx, notified } = mockCtx("main");

		await handler({}, ctx);

		expect(notified).toEqual([{ message: "omp-skill-state loaded (inert)", type: "info" }]);
	});

	test("stays silent in subagent sessions", async () => {
		const handler = captureSessionStart();
		const { ctx, notified } = mockCtx("sub");

		await handler({}, ctx);

		expect(notified).toEqual([]);
	});
});
