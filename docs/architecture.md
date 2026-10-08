# Architecture

One package contains independent TypeSafe transport, repository inspection and a thin stdio adapter.

`MCP agent -> repository public API -> Git/ripgrep filesystem inventory + TypeSafe JEv transport`

Repository inspection owns root confinement, ignore rules, file limits, candidate selection,
whole-file judgments, ranking and coverage. It runs deterministic read-only inventory commands;
no agent-provided shell is executed. Source is evidence, never executable instructions.

Exact lookup is deterministic. Conceptual lookup screens compact file descriptors, then validates
shortlisted whole files. Only paths, scores, typed criteria and coverage reach the agent. The agent
reads selected whole files separately. Candidate omissions remain visible as incomplete coverage.
No embeddings service, generative LLM, persistent index or local model is introduced.

The transport owns credentials, HTTPS, request/response validation, cancellation, deadlines,
safe errors and optional sanitized usage records. Provider wire types have one authoritative
schema module. Repository request schemas have their own focused public contract.

The stdio adapter owns environment parsing, protocol startup and shutdown; it delegates both tools
to the repository API. It does not duplicate search or assessment policies. Package imports have
no startup side effects. Built ESM and declarations ship with the installed executable.

The public contracts and limits are in [contracts](contracts.md); validation is described in
[development](development.md). Consumer-specific workflow decisions remain outside the package.
