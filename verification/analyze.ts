// Evidence extraction for a real omp session run under the skill-state runtime.
//
//   bun verification/analyze.ts <session.jsonl> [--titles <dir> <n>]
//
// Reads the stored transcript (never the prompt) and prints a timeline of
// steps and runtime events, token statistics over the projected steps, the
// compaction entries, the final state, and the subagent transcripts stored
// beside the session. --titles checks the recon procedure's findings against
// the H1 titles of the first <n> .md files of <dir> (case-insensitive order).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { CompactionEntry, ContextEvent, RawFileEntry } from "@oh-my-pi/pi-coding-agent";
import { PROCEDURE_SPEC_MESSAGE_TYPE as SPEC, RULES_MESSAGE_TYPE as RULES, STATE_MESSAGE_TYPE as STATE } from "../patch";

// The published root entry exports ContextEvent but not the message union itself.
type AssistantMessage = Extract<ContextEvent["messages"][number], { role: "assistant" }>;

function readEntries(file: string): RawFileEntry[] {
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter((line: string) => line.trim().length > 0)
		// The file is written by the harness itself; RawFileEntry is its own type for these lines.
		.map((line: string) => JSON.parse(line) as RawFileEntry);
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
}

function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const position = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
	return sorted[position]!;
}

interface Step {
	index: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	tools: number;
	// Set when a stored state message follows this step: the step's patch was
	// accepted. Read off the state messages, not the assistant text, because a
	// shake pass rewrites stored assistant text in place.
	changed: boolean;
	projected: boolean;
}

function stepOf(message: AssistantMessage, index: number, projected: boolean): Step {
	return {
		index,
		input: message.usage.input,
		cacheRead: message.usage.cacheRead,
		cacheWrite: message.usage.cacheWrite,
		output: message.usage.output,
		tools: message.content.filter((block) => block.type === "toolCall").length,
		changed: false,
		projected,
	};
}

function analyze(file: string, titles?: { dir: string; n: number }): void {
	const entries = readEntries(file);
	const header = entries.find((entry) => entry.type === "session");
	console.log(`# session ${file}`);
	console.log(`id=${header?.id} cwd=${header?.cwd} parentSession=${header?.parentSession ?? "-"} entries=${entries.length}`);

	const steps: Step[] = [];
	const compactions: CompactionEntry[] = [];
	let stateMessages = 0;
	let headRules = 0;
	let headSpec = 0;
	let shaken = 0;
	let lastState: Record<string, unknown> = {};
	// A state head message exists on the branch since the last reset or
	// invocation, so the next provider call can be projected.
	let headPresent = false;
	let model = "";
	// Disengaging leaves no stored trace (only a toast), so a run that went on
	// as an ordinary conversation shows as a stretch of steps with no state
	// message after them.
	let stepsSinceState = 0;

	console.log("\n## timeline");
	entries.forEach((entry, entryIndex) => {
		// A shake pass replaced this entry's text with a recovery placeholder.
		const stored = entry.type === "custom_message" ? textOf(entry.content) : entry.type === "message" && "content" in entry.message ? textOf(entry.message.content) : "";
		if (stored.includes("[shaken ~")) shaken++;
		switch (entry.type) {
			case "custom_message": {
				const details: unknown = entry.details;
				const detailsRecord: Record<string, unknown> = typeof details === "object" && details !== null ? (details as Record<string, unknown>) : {};
				if (entry.customType === "skill-prompt") {
					headPresent = false;
					console.log(`[${entryIndex}] skill-prompt attribution=${entry.attribution} name=${detailsRecord.name} args=${JSON.stringify(detailsRecord.args ?? "").slice(0, 120)}`);
				} else if (entry.customType === RULES) {
					headRules++;
					console.log(`[${entryIndex}] head rules`);
				} else if (entry.customType === SPEC) {
					headSpec++;
					console.log(`[${entryIndex}] head procedure-spec (${textOf(entry.content).length} chars)`);
				} else if (entry.customType === STATE) {
					stateMessages++;
					headPresent = true;
					stepsSinceState = 0;
					if (steps.length > 0) steps[steps.length - 1]!.changed = true;
					const state: unknown = detailsRecord.state;
					lastState = typeof state === "object" && state !== null && !Array.isArray(state) ? (state as Record<string, unknown>) : {};
					const findings = Array.isArray(lastState.findings) ? lastState.findings.length : "-";
					const open = Array.isArray(lastState.open_questions) ? lastState.open_questions.length : "-";
					console.log(`[${entryIndex}] state keys=${Object.keys(lastState).length} findings=${findings} open=${open}`);
				} else {
					console.log(`[${entryIndex}] custom_message ${entry.customType}`);
				}
				break;
			}
			case "message": {
				const message = entry.message;
				if (message.role !== "assistant") break;
				model = `${message.provider}/${message.model}`;
				const step = stepOf(message, steps.length + 1, headPresent);
				steps.push(step);
				stepsSinceState++;
				const toolNames = message.content.flatMap((block) => (block.type === "toolCall" ? [block.name] : [])).join(",");
				console.log(`  step ${step.index}${step.projected ? "" : " (unprojected)"}: in=${step.input} cache=${step.cacheRead}${step.cacheWrite ? `+w${step.cacheWrite}` : ""} out=${step.output} tools=${step.tools}${toolNames ? `[${toolNames}]` : ""} stop=${message.stopReason}`);
				break;
			}
			case "compaction": {
				compactions.push(entry);
				const preserve: unknown = entry.preserveData;
				const preserveState = typeof preserve === "object" && preserve !== null && "state" in preserve;
				console.log(`[${entryIndex}] COMPACTION tokensBefore=${entry.tokensBefore} tokensAfter=${entry.tokensAfter ?? "-"} method=${entry.method ?? "-"} fromExtension=${entry.fromExtension ?? "-"} firstKept=${entry.firstKeptEntryId} summary="${(entry.summary.split("\n")[0] ?? "").slice(0, 100)}" preserveState=${preserveState ? "yes" : "no"}`);
				break;
			}
			case "reset_boundary":
				headPresent = false;
				console.log(`[${entryIndex}] reset_boundary (/clear)`);
				break;
			case "custom":
				if (entry.customType !== "tool_execution_start") console.log(`[${entryIndex}] custom ${entry.customType}`);
				break;
			case "model_usage":
				console.log(`[${entryIndex}] model_usage purpose=${entry.purpose} role=${entry.role} model=${entry.provider}/${entry.model} input=${entry.usage.input}`);
				break;
			case "session":
			case "title":
			case "title_change":
			case "model_change":
			case "thinking_level_change":
				break;
			default:
				console.log(`[${entryIndex}] ${entry.type}`);
		}
	});

	console.log("\n## summary");
	const changed = steps.filter((step) => step.changed).length;
	console.log(`model=${model} steps=${steps.length} projected=${steps.filter((step) => step.projected).length} stateChangedSteps=${changed} stateMessages=${stateMessages} headRules=${headRules} headSpec=${headSpec} shakenEntries=${shaken}`);
	console.log(`steps after the last stored state: ${stepsSinceState}${stepsSinceState > 1 ? " (past the skill's idleSteps this means the runtime disengaged, or the final state was never stored)" : ""}`);

	const projected = steps.filter((step) => step.projected);
	if (projected.length > 0) {
		const promptOf = (step: Step): number => step.input + step.cacheRead + step.cacheWrite;
		const prompt = projected.map(promptOf).sort((a, b) => a - b);
		const input = projected.map((step) => step.input).sort((a, b) => a - b);
		const median = quantile(prompt, 0.5);
		console.log(`prompt tokens per projected step (input+cacheRead+cacheWrite): min=${prompt[0]} median=${median} p90=${quantile(prompt, 0.9)} max=${prompt[prompt.length - 1]} max/median=${(prompt[prompt.length - 1]! / median).toFixed(2)}`);
		console.log(`uncached input per projected step: min=${input[0]} median=${quantile(input, 0.5)} max=${input[input.length - 1]}`);
		const hits = projected.filter((step) => step.cacheRead > 0).length;
		const majority = projected.filter((step) => step.cacheRead >= promptOf(step) / 2).length;
		console.log(`cache: cacheRead>0 on ${hits}/${projected.length} projected steps; cacheRead>=50% of prompt on ${majority}/${projected.length}`);
		console.log(`first projected step prompt=${promptOf(projected[0]!)}, last=${promptOf(projected[projected.length - 1]!)}`);
	}

	const stateSummaries = compactions.filter((entry) => entry.summary.startsWith("Execution state of procedure")).length;
	console.log(`compactions=${compactions.length} fromExtension=${compactions.filter((entry) => entry.fromExtension === true).length} stateSummaries=${stateSummaries}`);

	console.log("\n## final state");
	console.log(JSON.stringify(lastState, null, 2));

	const artifacts = file.replace(/\.jsonl$/, "");
	console.log("\n## subagents");
	if (existsSync(artifacts) && statSync(artifacts).isDirectory()) {
		const files = readdirSync(artifacts).filter((name: string) => name.endsWith(".jsonl"));
		if (files.length === 0) console.log("(none)");
		for (const name of files) {
			const sub = readEntries(join(artifacts, name));
			const subHeader = sub.find((entry) => entry.type === "session");
			const assistant = sub.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
			const skillState = sub.filter((entry) => entry.type === "custom_message" && entry.customType.startsWith("sh.omp.skill-state")).length;
			const toolCalls = assistant.reduce((sum, message) => sum + message.content.filter((block) => block.type === "toolCall").length, 0);
			console.log(`${name}: parentSession=${basename(subHeader?.parentSession ?? "-")} assistantMessages=${assistant.length} toolCalls=${toolCalls} skillStateMessages=${skillState}`);
		}
	} else {
		console.log("(no artifacts directory)");
	}

	if (titles) {
		console.log(`\n## titles check (${titles.dir}, first ${titles.n} .md files, case-insensitive order)`);
		const files = readdirSync(titles.dir)
			.filter((name: string) => name.endsWith(".md") && statSync(join(titles.dir, name)).isFile())
			.sort((a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase(), "en"))
			.slice(0, titles.n);
		const findings = Array.isArray(lastState.findings) ? lastState.findings.map(String) : [];
		let matched = 0;
		for (const name of files) {
			const h1 = readFileSync(join(titles.dir, name), "utf8")
				.split(/\r?\n/)
				.find((line: string) => /^# /.test(line))
				?.replace(/^# /, "")
				.trim();
			const expected = `${name}: ${h1}`;
			if (findings.some((finding) => finding.trim() === expected)) matched++;
			else console.log(`MISSING ${expected}`);
		}
		console.log(`matched ${matched}/${files.length}; findings=${findings.length}`);
	}
}

const target = process.argv[2];
if (target === undefined) {
	console.error("usage: bun verification/analyze.ts <session.jsonl> [--titles <dir> <n>]");
	process.exit(2);
}
const titlesAt = process.argv.indexOf("--titles");
analyze(target, titlesAt > 0 ? { dir: process.argv[titlesAt + 1] ?? ".", n: Number(process.argv[titlesAt + 2]) } : undefined);
