import type { CustomMessagePayload, SessionBeforeCompactEvent, SessionBeforeCompactResult } from "@oh-my-pi/pi-coding-agent";
import { currentStepCut } from "./branch";
import type { AgentMessage } from "./types";
import { PROCEDURE_SPEC_MESSAGE_TYPE, consolidationNudgeMessage, coreMessage, nudgeMessage, renderStateContent, rulesMessage, scratchMessage } from "./messages";
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
	// One up-counter of replies seen: each recordReply is one step.
	step: number;
	// The step the nudge memo was computed for, and the set it returned, so
	// repeated pendingNudges calls inside one step re-serve the same answer
	// instead of re-evaluating or duplicating nudges.
	nudgedAt: number;
	nudgesMemo: AgentMessage[];
	// Whether the latest provider call carried the stored head. A step without
	// the stored head does not count as idle. The first step runs before the
	// engage asides land but has seen the rules through the before_agent_start
	// delivery; the step after a compaction can run before the re-sent head
	// lands, and there the model truly has not seen the rules.
	projected: boolean;
}

// Every procedure starts with fresh counters, from a new invocation and from a
// re-derive alike.
export function newProcedure(name: string, spec: string, schema: StateSchema, params: StateParams, state: ExecutionState): Procedure {
	return { name, spec, schema, params, state, invalidPatches: 0, idle: 0, capNudged: false, projected: false, step: 0, nudgedAt: -1, nudgesMemo: [] };
}

// What one reply did to the procedure. The factory acts on it: a stored patch
// is committed by the state_update execute later in the same step, an ended
// procedure is dropped and announced, and the other two need nothing from it.
export type StepOutcome =
	| { kind: "none" }
	| { kind: "store"; state: ExecutionState }
	| { kind: "block" }
	| { kind: "ended"; cause: "degrade" | "idle" };

// The step policy: validate and merge the reply's state_update patches, and
// decide what the reply means for the counters. The reply may carry several
// state_update calls; their patches fold in declaration order, each applying
// to the previous one's result, and the first invalid patch refuses the whole
// batch. The merged state rides on the store outcome; the tool's execute
// commits it, so the record's own state is untouched here. A reply with no
// state_update call, or whose fold leaves the state as it was, is an idle
// step; an invalid patch blocks the step and counts toward degrade; a patch
// of any kind, valid or not, breaks an idle run.
export function recordReply(procedure: Procedure, reply: { patches: unknown[]; hasPatch: boolean }): StepOutcome {
	// One reply is one step; the nudge memo is keyed to this counter.
	procedure.step += 1;
	if (!reply.hasPatch || reply.patches.length === 0) {
		procedure.pendingError = undefined;
		procedure.invalidPatches = 0;
		return idleStep(procedure);
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
	// nothing to store, and the model did not edit its state this step.
	if (!anyChanged) return idleStep(procedure);
	procedure.idle = 0;
	return { kind: "store", state: candidateState };
}

// A step the model spent without editing its state. A step whose prompt
// carried no stored head does not count: the rules were not in its prompt.
function idleStep(procedure: Procedure): StepOutcome {
	if (!procedure.projected) return { kind: "none" };
	procedure.idle += 1;
	if (procedure.idle >= procedure.params.idleSteps) return { kind: "ended", cause: "idle" };
	return { kind: "none" };
}

// The pending error blocks the step's tool calls. On the retries-th
// consecutive failure the procedure degrades, and the error dies with it: the
// degrading step runs its tools as an ordinary step would.
function invalidPatch(procedure: Procedure, error: string): StepOutcome {
	procedure.pendingError = error;
	procedure.invalidPatches += 1;
	procedure.idle = 0;
	if (procedure.invalidPatches >= procedure.params.retries) return { kind: "ended", cause: "degrade" };
	return { kind: "block" };
}

export function noteProjected(procedure: Procedure, projected: boolean): void {
	procedure.projected = projected;
}

// The one write path for a merged state: the tool execute commits through
// this, and so do the tests, so the state/idle reset policy has a single home
// and can never diverge between call sites.
export function commitPatch(procedure: Procedure, state: ExecutionState): void {
	procedure.state = state;
	procedure.idle = 0;
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
// order: the consolidation ask first, the idle cutoff last. Only for a call
// whose prompt carries the stored head. Idempotent within a step: repeated
// calls before the next reply re-serve the memo, so a re-run context handler
// cannot duplicate nudges or re-latch the cap ask.
export function pendingNudges(procedure: Procedure): AgentMessage[] {
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
	// The idle cutoff rides at threshold minus one; idle > 0 keeps a skill
	// that sets idleSteps to 1 from nudging on every single step, where no
	// quiet step could ever precede the cutoff.
	if (procedure.projected && procedure.idle > 0 && procedure.idle === procedure.params.idleSteps - 1) {
		nudges.push(nudgeMessage(procedure.idle));
	}
	procedure.nudgedAt = procedure.step;
	procedure.nudgesMemo = nudges;
	return nudges;
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
