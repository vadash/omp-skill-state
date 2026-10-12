// Verification instrument for the real-session runs: captures every provider
// request payload so a run can prove where per-call-only material appears —
// that the scratch copy's distinguishing field never reaches the wire and that
// the nudges ride exactly the prompts the policy names. Dormant unless
// SKILL_STATE_CAPTURE_DIR is set: a linked plugin loads in every session, so
// the env var is what scopes capture to one run.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { appendFile } from "node:fs/promises";

export default function (pi: ExtensionAPI): void {
	const dir = process.env.SKILL_STATE_CAPTURE_DIR;
	if (!dir) return;
	let seq = 0;
	pi.on("before_provider_request", (event: { payload: unknown }) => {
		const record = { seq: ++seq, t: new Date().toISOString(), payload: event.payload };
		void appendFile(`${dir}/requests.jsonl`, `${JSON.stringify(record)}\n`).catch(() => {});
		// Pass the payload through untouched: capture must not change what is sent.
		return event.payload;
	});
}
