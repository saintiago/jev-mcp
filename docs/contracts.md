# API and MCP contracts

## Repository API

`createRepositoryClient(client, directory)` returns `searchRepo(request, {signal}?)` and
`inspectFiles(request, {signal}?)`. The directory identifies the Git checkout; paths are relative
to its root. Reject absolute paths, traversal and escaping symlinks before provider calls.
Respect Git ignore rules. Read source directly, without returning its contents to the agent.

`search_repo({query, scope?, limit?})`: limit defaults to 10, maximum 30. A standalone symbol
or a quoted literal uses ordinary text lookup without JEv. Conceptual queries use JEv screening
of file names/introduction/declarations, followed by whole-file judgments on up to 60 candidates
(at least 12, or three times the requested result limit). Return only judgments scoring at least
0.65. Candidate screening is retrieval guidance, not proof of absence. Related direct callers
may also be relevant. Empty results are supported.

`inspect_files({paths, questions})`: up to 30 paths and 16 `{id, question}` entries with unique
IDs. Each file is supplied in full to JEv, with all questions. Return original criteria and typed
scores: `evidence` at 0.65 or above, `insufficient_evidence` at 0.4–0.65, `not_found` below 0.4.
These labels describe assessments of supplied evidence, not established correctness.

Both tools return source state (HEAD, dirty working tree flag, digest of files actually read),
coverage (discovered/read/inspected counts, completeness, skipped files) and aggregate provider
usage (attempt count includes failures/retries; token counts include successful responses only). They return no generated explanations or source excerpts. A digest identifies read
content, not an atomic repository snapshot. Candidate filtering explicitly limits completeness.

Use Git's tracked and nonignored untracked inventory, including nonignored hidden files. At most
600 files are read per discovery; inventory overflow is reported. Binary, unreadable and files
larger than 128000 bytes are skipped, never silently truncated. Ignored inspection paths are
reported as skipped. Missing/non-directory scope is invalid input. An empty scope returns an
empty result. Tools never execute source or accept shell commands.

Repository evaluations retry once after a randomized 250–499ms delay for timeout, rate limiting,
network unavailability or HTTP 5xx. Concurrency remains four. A second provider failure is reported
per affected file as `evaluation_failed` with its safe `errorCode`; successful evaluations remain in
the result and coverage is incomplete. Failed candidate batches report every affected path and do
not receive a negative score. Authentication, invalid input and cancellation still fail the call.
Invalid provider responses are reported as failed evaluations without retrying. There is no fallback
model. The low-level transport itself does not retry.

## MCP startup and lifecycle

The installed `jev-mcp` executable exposes exactly `search_repo` and `inspect_files`, bound to
its working directory. Host environment supplies `JEV_API_KEY`, optional `JEV_MODEL`,
`JEV_TIMEOUT_MS`, and optional `JEV_USAGE_LOG_PATH` / `JEV_USAGE_LOG_CALLER`. Credentials,
model settings and repository root are not tool arguments. Stdout is protocol-only. Cancellation
propagates through file operations and provider calls; EOF and termination close the server.
Optional usage logs contain metadata, never raw source, queries or credentials.

## Provider transport

`createJevClient(options).evaluate(request, {signal}?)` is the independent low-level transport.
It supports typed noul, choice and score questions at the fixed TypeSafe System One endpoint,
using bearer authentication. Defaults: `jev-1.13.0`, 30000ms per provider request. Validate
request/response shapes, preserve provider values, and use safe `JevError` categories for
invalid input/response, authentication, rate limiting, timeout, cancellation and unavailability.
There are no automatic retries or fallback models. The repository tools use noul judgments.

## Validation

Verify literal zero-provider lookup, conceptual full-file validation, related files, empty results,
source exclusion from tool results, limits and incomplete coverage, path/ignore boundaries,
safe failures, cancellation, stdio discovery and clean packed consumption. Live discovery
checks known targets, misleading neighbors and absent features; it is not a proof of recall.
