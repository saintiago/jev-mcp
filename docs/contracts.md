# API and MCP contracts

## Repository API

`createRepositoryClient(client, directory, retrievalLog?)` returns `retrieveEvidence(request, {signal}?)`
and `expandEvidence(request, {signal}?)`. The directory identifies a Git checkout. Paths are relative
to its root. Absolute paths, traversal, NULs and escaping symlinks are rejected. Git ignore rules apply
to both requested aliases and resolved targets. The whole expansion batch is confined before reading.

`retrieve_evidence({question?, scope?, terms?, maxChars?})` requires a question or literal terms.
Scope defaults to the repository root and accepts a file or directory. Up to 16 terms, each 200
characters, are passed as literal ripgrep patterns. The question is at most 4000 characters.
`maxChars` defaults to 16000 and ranges from 1000 to 64000; it budgets returned source text.

Exact discovery returns surrounding lines without JEv when evidence fits. A question enables semantic
fallback for zero exact hits and relevance screening when exact evidence exceeds the budget.
Conceptual lookup screens descriptors in batches of 12, then up to 24 candidate files in 60-line
sections. Descriptors scoring at least 0.2 become candidates; sections scoring at least 0.4 become
possible evidence. Scores are internal relevance hints, not correctness judgments. Sections larger
than 24000 characters are omitted explicitly. Windows are merged, balanced across files and bounded
at whole lines. Source may be incomplete; no match is not proof of absence.

Discovery reads Git tracked and nonignored untracked inventory, including hidden files, up to 600
files and 512000 bytes per file. Binary/invalid-UTF-8, unreadable, ignored, oversized and escaping inventory links are reported.
An explicitly requested escaping path remains invalid input.
Inventory overflow, candidate selection, semantic filtering and budget truncation are explicit limits.

`expand_evidence({requests})` accepts 1–30 `{path, start?, end?, full?}` entries. Line numbers are
one-based and inclusive; omitted end reads through EOF. `full: true` reads the entire file and cannot
be combined with line bounds. Inverted ranges and starts beyond EOF are invalid. Ends beyond EOF are
clamped. Overlapping/adjacent ranges merge. Expansion bypasses JEv and discovery file-size/output
budgets; the caller explicitly chooses how much source to load. Binary, ignored or missing files are
reported rather than invented. No commands or code modifications are accepted.

Both operations return exact `windows: [{path,start,end,text}]` and per-file total lines/omission
flags. Text has no inserted line prefixes or generated summaries. `source` contains the absolute root,
HEAD, dirty flag and digest of bytes actually read, not an atomic filesystem snapshot. `coverage`
contains discovered/read/inspected counts, explicit limits and skipped files. Completeness describes
search coverage, not whether the agent has enough evidence. `usage` counts provider attempts including
failures/retries and tokens from successful responses only. The notice identifies partial evidence and
unfiltered batched expansion. Section scores never reach the agent as approval or correctness labels.

Repository evaluations retry once after 250–499ms jitter for timeout, rate limit, network unavailability
or HTTP 5xx. Concurrency is four. Exhausted transient errors and invalid responses produce per-file
`evaluation_failed` entries with safe error codes and incomplete coverage. Authentication, invalid
input and cancellation fail the call. Explicit retrieval/expansion remains available without provider
calls. The low-level transport does not retry or substitute models.

## MCP startup and lifecycle

The installed `jev-mcp` executable exposes exactly `retrieve_evidence` and `expand_evidence` in its
working directory. Host settings are `JEV_API_KEY`, optional `JEV_MODEL`, `JEV_TIMEOUT_MS`,
`JEV_USAGE_LOG_PATH`, `JEV_USAGE_LOG_CALLER` and `JEV_RETRIEVAL_LOG_PATH`. Repository root,
credentials and model settings are not tool arguments. Stdout is protocol-only. Cancellation reaches
provider calls, inventory commands and file reads; EOF and termination close the server.

## Local usage logging

Logging is opt-in and local. Provider usage records retain the existing sanitized transport metadata;
repository calls suppress supplied questions. Retrieval records contain timestamp, operation, method,
duration, counts, returned source characters, coverage limits, skipped-reason counts, aggregate provider
usage and optional caller. Errors log only safe codes. Neither log contains source, questions, search
terms, source paths, credentials, authentication headers or raw provider error bodies. Retrieval log
failures never change the operation result. Newly created logs use owner-only permissions.

## Provider transport

`createJevClient(options).evaluate(request, {signal}?)` remains the independent transport for typed
noul, choice and score questions at the fixed TypeSafe System One endpoint. Defaults: `jev-1.13.0`,
30000ms per request. It owns request/response validation, safe errors and no automatic retries.

## Validation

Verify batched source fidelity, original line bounds, overlap merging, explicit budgets and omissions,
zero-provider exact discovery/expansion, semantic retrieval, coverage, confinement and ignore rules,
large explicit reads, cancellation, partial failures, logging privacy, stdio lifecycle and packed
consumption. Controlled providers drive default tests. Explicit live comparisons report quality,
agent input/cache usage, latency, turns and failures; small samples do not establish general savings.
