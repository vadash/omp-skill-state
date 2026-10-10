import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		ctx.ui.notify("omp-skill-state loaded (inert)", "info");
	});
}
