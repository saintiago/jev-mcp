# Purpose and scope

Help coding agents find relevant repository files before loading source into their context.
JEv supplies structured judgments; no generative LLM produces explanations.

The stdio tools are `search_repo` and `inspect_files`. They read repository content themselves,
return paths and typed assessments, and let agents read selected whole files. There is no
`ask_jev` tool, precise excerpt selection, history pruning, memory management, autonomous shell
execution, code modification or workflow approval gate. No persistent index is maintained.

The TypeScript provider client remains the low-level TypeSafe transport. Repository tools own
candidate screening, file access, relevance thresholds and coverage. Consumers own actions.
A negative judgment does not prove absence or bug freedom. Scores are advisory.
