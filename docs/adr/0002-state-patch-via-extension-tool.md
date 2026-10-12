# State patches travel as a strict extension tool

The fenced-block patch channel had two structural defects: the operating rules are absent from the first step's prompt (the engage asides land later), so every procedure skill had to restate the fence format and a skill that forgot silently lost its first patch; and freehand fenced JSON is the paper's measured small-model failure mode (~12% malformed). We move the patch onto an extension tool, `state_update`, registered through the harness's public `registerTool` at engage — so the channel exists from the very first step — with a strict wrapper parameter holding the whole Δt, zero approval via the definition-level `{ tier: "read", policy: "allow" }` decision, and application in the tool's execute. All-or-nothing is preserved by validating the reply's tool-call blocks during `assistant_message` and letting the existing `tool_call` blocking path refuse the whole batch, including the `state_update` call itself, while the patch is invalid. The fenced block and its parser are deleted outright, not kept as a fallback: tool arguments are protocol-level JSON, so the fence's failure class does not exist on this channel, and two accepted channels would force a precedence rule into every doc and test surface.

## Considered options

- **Keep the fenced block as a fallback.** Rejected: a precedence rule forever, and a parser kept alive for a failure class tool arguments cannot produce.
- **Repair malformed JSON before validation** (e.g. jsonrepair). Rejected: silent repair can produce different state than the model meant — corrupting the only record of the past — where the block-retry-degrade path reports exact errors.
- **Expose the tool through an MCP server.** Rejected: extra prompt cost and a moving part for the same definition the extension API registers directly.
- **Add the tool natively in the harness.** Rejected: the public extension surface is sufficient; the harness tree stays read-only.
- **Deactivate the definition when disengaged.** Rejected: no unregister exists, and Anthropic replays retired definitions as prompt anyway — so deactivation buys nothing and adds a moving part.

## Consequences

Registration is permanent for the session: after disengage the definition stays registered and `execute` returns a graceful "no active procedure" error; ordinary sessions that never engage a procedure never see the definition. This supersedes the deferral in spec section 8 ("the tool is added only if a measured failure rate justifies it") — the tool is the only channel. The finish protocol is unchanged: a reply with no tool call still ends the run; skills teach one final consolidating patch before it. A model double-encoding the patch as a JSON string is handled by a three-line coercion in execute, to be added only if a verification run shows it happening.
