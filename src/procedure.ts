import type { CustomMessagePayload, SessionBeforeCompactEvent, SessionBeforeCompactResult } from "@oh-my-pi/pi-coding-agent";
import { currentStepCut } from "./branch";
import type { AgentMessage } from "./types";
import { PROCEDURE_SPEC_MESSAGE_TYPE, consolidationNudgeMessage, coreMessage, degradationNoticeMessage, fallbackNoticeMessage, idleNudgeMessage, renderStateContent, rulesMessage, scratchMessage, windowNoticeMessage } from "./messages";
import { pairTag, project } from "./projection";
import { applyPatch, splitState } from "./state";
import type { ExecutionState, StateParams, StateSchema } from "./state";

// One run of a procedure skill (CONTEXT.md: Procedure). Everything the step
// policy needs from the past lives here; the factory holds one per engaged
// session and never edits the counters itself.
export interface Procedure {
	name: string;
	// P, held so a re-head after compaction never depends on a branch scan.
	spec: string;
	schema: StateSchema;
	params: StateParams;
	state: ExecutionState;
	// The validation error of the current step's patch. While set, every tool
	// call of the step is blocked with it; the next reply clears it.
	pendingError?: string;
	invalidPatches: number;
	idle: number;
	// Whether the consolidation nudge already fired in the current over-cap
	// episode. pendingNudges latches it when it hands the nudge out; a commit
	// that lands the state back under the cap re-arms it there.
	capNudged: boolean;
	// Whether the idle ask already fired in the current quiet episode.
	// pendingNudges latches it when it hands the ask out; breakIdle re-arms it
	// with the counter when the episode ends.
	idleNudged: boolean;
	// Whether the fallback notice already fired in the current unprojected
	// episode. stepPrompt latches it when it hands the notice out; a projected
	// step ends the episode and re-arms it there.
	fallbackNoticed: boolean;
	// One up-counter of replies seen: each recordReply is one step.
	step: number;
	// The step the nudge memo was computed for, and the set it returned, so
	// repeated pendingNudges calls inside one step re-serve the same answer
	// instead of re-evaluating or duplicating nudges.
	nudgedAt: number;
	nudgesMemo: AgentMessage[];
	// Whether the latest provider call was a normal projection carrying the
	// stored head. A fallback step sets it false because the rules were not in
	// its prompt; a degraded step sets it false too, because the step is
	// policy-neutral (ADR 0005): the degradation moves no counter, though the
	// reply itself still folds normally. The first step runs before the
	// engage asides land but has seen the rules through the before_agent_start
	// delivery; the step after a compaction can run before the re-sent head
	// lands, and there the model truly has not seen the rules.
	projected: boolean;
}

// Every procedure starts with fresh counters, from a new invocation and from a
// re-derive alike.
export function newProcedure(name: string, spec: string, schema: StateSchema, params: StateParams, state: ExecutionState): Procedure {
	return { name, spec, schema, params, state, invalidPatches: 0, idle: 0, capNudged: false, idleNudged: false, fallbackNoticed: false, projected: false, step: 0, nudgedAt: -1, nudgesMemo: [] };
}

// What one reply did to the procedure. The factory acts on it: an ok step's
// patches are committed by the state_update executes later in the same step,
// an ended procedure is dropped and announced, and the other two need nothing
// from it. Idleness never ends a procedure, so degrade is the only ended
// cause.
export type StepOutcome =
	| { kind: "none" }
	| { kind: "ok" }
	| { kind: "block" }
	| { kind: "ended"; cause: "degrade" };

// The step policy: validate and merge the reply's state_update patches, and
// decide what the reply means for the counters. The reply may carry several
// state_update calls; their patches fold in declaration order, each applying
// to the previous one's result, and the first invalid patch refuses the whole
// batch. The fold is the step's verdict only: the record's own state is
// untouched here, and each execute commits its own patch through commitStep
// against the state the previous one left. A reply with no
// state_update call, or whose fold leaves the state as it was, is an idle
// step; an invalid patch blocks the step and counts toward degrade; a patch
// that changes the state, or an invalid one, breaks an idle run.
export function recordReply(procedure: Procedure, reply: { patches: unknown[]; hasPatch: boolean }): StepOutcome {
	// One reply is one step; the nudge memo is keyed to this counter.
	procedure.step += 1;
	if (!reply.hasPatch || reply.patches.length === 0) {
		procedure.pendingError = undefined;
		procedure.invalidPatches = 0;
		idleStep(procedure);
		return { kind: "none" };
	}
	let candidateState = procedure.state;
	let anyChanged = false;
	for (const patch of reply.patches) {
		const applied = applyPatch(candidateState, patch, procedure.schema);
		if (!applied.ok) return invalidPatch(procedure, applied.error);
		candidateState = applied.state;
		if (applied.changed) anyChanged = true;
	}
	procedure.pendingError = undefined;
	procedure.invalidPatches = 0;
	// A fold that leaves the state as it was is an empty patch: there is
	// nothing to commit, and the model did not edit its state this step.
	if (!anyChanged) {
		idleStep(procedure);
		return { kind: "none" };
	}
	breakIdle(procedure);
	return { kind: "ok" };
}

// A step the model spent without editing its state. A step whose prompt
// carried no stored head does not count: the rules were not in its prompt. A
// degraded step does not count either: the degradation is policy-neutral
// (ADR 0005), the reply's own validity is judged elsewhere as usual. An idle
// step never ends anything; it only advances the counter the idle ask reads.
function idleStep(procedure: Procedure): void {
	if (!procedure.projected) return;
	procedure.idle += 1;
}

// The pending error blocks the step's tool calls. On the retries-th
// consecutive failure the procedure degrades, and the error dies with it: the
// degrading step runs its tools as an ordinary step would.
function invalidPatch(procedure: Procedure, error: string): StepOutcome {
	procedure.pendingError = error;
	procedure.invalidPatches += 1;
	breakIdle(procedure);
	if (procedure.invalidPatches >= procedure.params.retries) return { kind: "ended", cause: "degrade" };
	return { kind: "block" };
}

// The one way a quiet episode ends: a patch that changed the state, or an
// invalid one. The counter and the ask's latch re-arm together, so the ask
// can never fire again without idleSteps fresh quiet steps (spec section 11).
function breakIdle(procedure: Procedure): void {
	procedure.idle = 0;
	procedure.idleNudged = false;
}

// The one write path for a merged state: every commit goes through this. A
// commit is a patch that changed the state, so it breaks the quiet episode
// through breakIdle, like every other episode breaker.
function commitPatch(procedure: Procedure, state: ExecutionState): void {
	procedure.state = state;
	breakIdle(procedure);
}

// The state_update execute's whole policy: apply the call's patch to the
// committed state and, on a real change, commit it and build the two stored
// state messages to send. The fold in recordReply validated this patch
// against the same intermediate state, so the repeat here is defensive only
// (spec section 8.4): an impossible failure comes back as the exact error in
// a failed tool result.
export function commitStep(procedure: Procedure, patch: unknown): { result: string; sends: CustomMessagePayload[] } | { error: string } {
	const applied = applyPatch(procedure.state, patch, procedure.schema);
	if (!applied.ok) return { error: applied.error };
	// A patch that leaves the state as it was is an empty patch: no commit,
	// no send.
	if (!applied.changed) return { result: "no change to the execution state", sends: [] };
	commitPatch(procedure, applied.state);
	return { result: "execution state updated", sends: stateMessages(procedure) };
}

// Over the soft state cap, the consolidation ask rides once per episode:
// capNudged latches when the nudge is handed out and re-arms when the
// committed state measures back under the cap. The cap never blocks, never
// ends the procedure: this query only decides what the next prompt carries.
// The measurement is the sum of both stored state messages' rendered content,
// the core's and the scratch's.
function overCap(procedure: Procedure): boolean {
	if (procedure.params.stateBytes <= 0) return false;
	const { core, scratch } = statePartitions(procedure);
	return Buffer.byteLength(renderStateContent(core)) + Buffer.byteLength(renderStateContent(scratch)) > procedure.params.stateBytes;
}

// The turn-scoped nudges the next provider call should carry, in delivery
// order: the consolidation ask first, the idle ask last. Only for a call
// whose prompt carries the stored head. Idempotent within a step: repeated
// calls before the next reply re-serve the memo, so a re-run context handler
// cannot duplicate nudges or re-latch an ask.
function pendingNudges(procedure: Procedure): AgentMessage[] {
	if (procedure.nudgedAt === procedure.step) return procedure.nudgesMemo;
	const nudges: AgentMessage[] = [];
	if (procedure.projected && overCap(procedure)) {
		if (!procedure.capNudged) {
			procedure.capNudged = true;
			nudges.push(consolidationNudgeMessage());
		}
	} else {
		procedure.capNudged = false;
	}
	// The idle ask rides the first prompt after idleSteps consecutive idle
	// steps, once per quiet episode: idleNudged latches when it is handed out,
	// and breakIdle re-arms it with the counter when the episode ends. A
	// reminder, never a deadline: the run continues either way.
	if (procedure.projected && procedure.idle >= procedure.params.idleSteps && !procedure.idleNudged) {
		procedure.idleNudged = true;
		nudges.push(idleNudgeMessage(procedure.idle));
	}
	procedure.nudgedAt = procedure.step;
	procedure.nudgesMemo = nudges;
	return nudges;
}

// The context handler's whole job: project the step's prompt, note whether
// the stored head reached it — the fold counts only steps that saw the rules
// — and append the turn's nudges. The tail is read from the branch, not from
// the prompt the event carries, so a compaction cut cannot shorten it; the
// window size comes from the harness's context-usage read. An unprojected
// step keeps the ordinary context and carries the fallback notice once per
// episode: the first unprojected step latches fallbackNoticed and rides the
// notice, later ones return undefined untouched, and a projected step re-arms
// the latch. A degraded step (ADR 0005) takes the middle road: the head is
// intact, so its prompt is the head plus the degradation notice, never
// ordinary history, and it stays policy-neutral — projected goes false, so
// the reply moves no counter by way of the degradation and no policy nudge
// rides. The degradation notice has no latch: it rides every degraded step,
// and the first projected step is its re-arm. The whole prompt is never
// memoized because a same-step context re-run after a compaction must rebuild
// from the new messages; only the nudge memo, which is not stale-prone, is.
// The projected flag, the notice latch, the nudge memo and its step key are
// private machinery: a caller cannot note without nudging or nudge without
// noting, so the note-before-nudge ordering the two-call seam needed is
// unstateable from outside.
export function stepPrompt(
	procedure: Procedure,
	messages: AgentMessage[],
	branch: readonly AgentMessage[] = messages,
	contextWindowTokens: number | undefined = undefined,
): AgentMessage[] | undefined {
	const projection = project(messages, branch, procedure.params, contextWindowTokens);
	if (typeof projection === "string") {
		procedure.projected = false;
		if (procedure.fallbackNoticed) return undefined;
		procedure.fallbackNoticed = true;
		return [...messages, fallbackNoticeMessage()];
	}
	// Degraded: head plus the degradation notice and nothing else. The head
	// reaching the prompt re-arms the fallback latch, the way a projected
	// step does.
	if ("head" in projection) {
		procedure.projected = false;
		procedure.fallbackNoticed = false;
		return [...projection.head, degradationNoticeMessage()];
	}
	procedure.projected = true;
	procedure.fallbackNoticed = false;
	// The window notice rides this seam ahead of the nudges: data about the
	// tail precedes the policy asks built on it. The projected prompt's tool
	// results are exactly the tailed results, and the tags re-mint from the
	// tool call ids, so no tail state crosses the seam.
	const tailed = projection.filter((message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult");
	const notice = tailed.length > 0
		? [windowNoticeMessage(tailed.map((result) => ({ tag: pairTag(result.toolCallId), toolName: result.toolName })))]
		: [];
	const nudges = pendingNudges(procedure);
	const perCall = [...notice, ...nudges];
	return perCall.length > 0 ? [...projection, ...perCall] : projection;
}

// The current state split into its two stored partitions, derived from the
// schema the record already holds; nothing about the split is remembered.
function statePartitions(procedure: Procedure): { core: ExecutionState; scratch: ExecutionState } {
	return splitState(procedure.state, procedure.schema);
}

// The two stored state messages of the current state, core first. Shared by
// the head, the patch aside and the final-state send, so every stored
// checkpoint has the same shape.
export function stateMessages(procedure: Procedure): CustomMessagePayload[] {
	const { core, scratch } = statePartitions(procedure);
	return [coreMessage(core), scratchMessage(scratch)];
}

// The head: the operating rules, P, the state core and the scratch state, one
// message each so the projection can take the last stored copy of every type.
// Byte-equal for the same state on every call, which is what lets a head
// re-sent after a compaction keep the provider's cache prefix. An empty core
// still renders as a stored empty-object message: the head is complete only
// with all four.
export function headMessages(procedure: Procedure): CustomMessagePayload[] {
	return [
		rulesMessage(),
		{ customType: PROCEDURE_SPEC_MESSAGE_TYPE, content: procedure.spec, display: false, details: { name: procedure.name } },
		...stateMessages(procedure),
	];
}

// The compaction while engaged (ADR 0001): the summary is the full state, the
// cut is the current step, and both state partitions ride along in
// preserveData so the next compaction can carry them forward. No summarizer
// call is involved; the factory only registers the handler and guards the
// session.
export function compactionFor(
	procedure: Procedure,
	preparation: Pick<SessionBeforeCompactEvent["preparation"], "firstKeptEntryId" | "tokensBefore">,
	branchEntries: SessionBeforeCompactEvent["branchEntries"],
): SessionBeforeCompactResult {
	const { core, scratch } = statePartitions(procedure);
	return {
		compaction: {
			summary: `Execution state of procedure "${procedure.name}" (skill-state runtime):\n\n${JSON.stringify(procedure.state, null, 2)}`,
			shortSummary: `skill-state: procedure "${procedure.name}" execution state`,
			firstKeptEntryId: currentStepCut(branchEntries) ?? preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			preserveData: { core, scratch },
		},
	};
}
