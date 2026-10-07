# Architecture

One npm package contains a public client and a thin stdio MCP adapter.

```text
TypeScript application --> public JEv client --> TypeSafe HTTPS API
MCP agent --> stdio adapter --> public JEv client
```

## Client

Own request/result schemas, public types, configuration validation, provider HTTP,
cancellation, timeout and errors. Use native fetch. Public imports must not start
processes, read environment variables, make network calls or load MCP startup code.
Validate requests before sending and provider output before returning.

Its public interface is in [contracts](contracts.md). Its external provider boundary
is TypeSafe's documented System One API. One provider does not justify a plugin
framework.

### Contract definitions

Keep Zod request/result schemas in one shared contract module, with public
TypeScript types derived from them. Model questions and answers as discriminated
unions on `type`; maps retain caller-supplied question IDs and choice labels.
Use the provider's documented field names and shapes directly, without a second
normalized representation. The client and MCP registration use the same schema
definitions; request-relative result checks belong to the client.

Validate JSON compatibility before recursive schema parsing or serialization.
State, instructions and descriptions are data: reject cycles, unsupported values
and nonfinite numbers with `invalid_input`, rather than coercing them or exposing
a serializer error. Nested JSON scalars remain valid where the contract allows
objects or arrays. Do not add content-size limits or interpret evidence as file
paths, templates or executable instructions. Preserve arbitrary map keys using
own-property lookup and safe record construction.

Parse into a request snapshot before starting asynchronous work. Use that same
snapshot to serialize the provider request and check its response, so caller
mutation cannot change validation after submission. Validate every requested
answer's type and its choice labels/distribution or score level indices against
the submitted criteria. Check the documented numeric ranges and required fields;
do not reconstruct the selected answer, legend, confidence or probabilities.
Accept compatible extra response properties, returning the documented fields
with their original values. Do not enforce an exact probability sum.

### Evaluation lifecycle

Validate configuration when constructing the client and input before network
activity. The client retains explicit configuration in memory and has no startup
or shutdown operation. Each `evaluate` call owns its resources independently:

1. Validate and snapshot the request, then check caller cancellation.
2. Start one deadline and one AbortController; forward caller cancellation to
   that controller and record which cancellation source occurred first.
3. Use native fetch for one authenticated POST to the fixed System One endpoint,
   containing the snapshot and configured model. No retries or fallback calls.
4. Keep the deadline and signal active through successful response body reading,
   JSON parsing and validation. Map unsuccessful HTTP status directly without
   using the provider error body as a message; release any unread body.
5. Return the validated result or a `JevError`. In `finally`, clear the timer and
   remove the caller listener on every path.

When logging is enabled, an outer per-call boundary captures start time before
step 1, retains the snapshot if validation succeeds, and observes the result or
failure. After evaluation cleanup, it records elapsed time and attempts one append
before settling with the original result or error. This boundary includes local
validation and already-cancelled calls, which currently exit before the network
`try/finally`; do not instrument only the fetch path. Obtain one request snapshot
and share it with provider serialization, result checks and log projection instead
of parsing twice. The disabled path needs no logging work.

The recorded abort source distinguishes `timeout` from `cancelled`, including
when cancellation interrupts the body read. Error categorization is owned here,
as specified by [contracts](contracts.md#failures); neither native error messages,
abort reasons, Zod diagnostics nor raw provider bodies become public messages.
Retain the HTTP status when known. The optional local usage log follows
[contracts](contracts.md#local-usage-logging); it must not change evaluation results.
Credentials stay in client configuration and the Authorization header. Supplied
state exists only in the call and its provider payload, never in the usage log.

### Local usage writer

The client owns the opt-in behavior and record projection; a small private
`src/usage-log.ts` helper owns JSONL serialization and file append. The public
configuration and record fields belong to
[contracts](contracts.md#configuration-and-record-format). Validate and copy
logging options with the other client options, without checking the filesystem
or opening a file during construction. Neither writer nor client reads environment.

Project only the validated questions and allowed result/error fields into a
record. The writer receives that record and the selected path, never the full
request, credentials, headers, provider response or raw exception. Serialize the
record before queueing, so pending appends retain only the allowed JSON line and
cannot observe caller mutation. Do not retain supplied state in client-level or
writer-level state. Use wall time for the start timestamp and a monotonic clock
for elapsed evaluation time.

Use native `node:fs/promises` append with UTF-8, append mode and mode `0600` for
new files. Keep a single promise tail per client to serialize its appends; a
failed append is contained so later calls can still write. Await the attempt only
after provider resources have been released. Contain record construction,
serialization and I/O failures without changing the evaluation result or original
error. Write no logging diagnostics to stdout or stderr. Do not create parent
directories, retry, rotate files, keep open handles or add a flush/shutdown API.
This needs no dependency, shared service, global path registry or logger framework.
Cross-client/process locking is outside the single-writer usage documented in
the contract; independent hosts can choose separate files.

## MCP adapter

Own process startup, environment configuration and the MCP protocol. Expose one
tool; delegate evaluation through the client's public contract. Use the maintained
MCP SDK and shared schemas. Stdout is protocol-only; safe diagnostics use stderr.
Closing the connection releases resources and aborts outstanding requests.

Its external interface is `ask_jev`, specified in [contracts](contracts.md). Only
the adapter reads process environment. It does not import client internals to
reproduce evaluation rules.

At startup, parse the optional timeout environment value without accepting an
empty value or trailing nonnumeric text; pass the resulting options to
`createJevClient`, which owns configuration validation. Startup diagnostics name
a setting only when a check performed here establishes it; other configuration
failures use one safe, non-attributing message. Register the shared request/result
schemas with the maintained MCP SDK, but keep tool-argument parsing from
transforming the request: the SDK parses arguments before the handler runs, so
registration must preserve arbitrary own JSON keys such as `__proto__`. The
handler passes the SDK's per-request signal to `evaluate`, then returns the same
result as `structuredContent` and JSON text. Convert `JevError` to an `isError`
tool result containing its safe code/message and status when present. Unexpected
failures receive a fixed safe message; protocol input failures remain with the
SDK. Diagnostics must not print raw exceptions or configuration values.

Map the host's usage-log environment settings to the public client options at
startup. The adapter neither builds records nor writes them. Keep `ask_jev` input
and output schemas unchanged; logging paths and attribution never become tool
arguments or provider payload fields. Replace the unconditional no-local-file-write
description with the optional host-enabled usage write and set `readOnlyHint`
according to host enablement. Update the existing discovery assertions together
with this description and annotation, preserving disabled-mode behavior.

Use the SDK's request cancellation and connection-close abort behavior instead
of maintaining a parallel collection of in-flight requests. The executable must
connect stdin EOF and termination signals to one idempotent server-close path;
stdio transport startup alone must not be assumed to handle EOF. Closing the
server then aborts handler signals, which release client calls through their
normal cleanup. Remove process listeners during shutdown. Test EOF shutdown with
an outstanding provider call, without relying on a test runner to kill the child.

## Composition and ownership

The package entry point exports the client; the executable starts the adapter.
They share contract definitions. There is no shared service. The opt-in local
usage log is the only persistent output; every request supplies its own evidence.
The adapter uses the public client's logging capability so one evaluation produces
one record. Consumers supply any caller label; the package owns no identity system.

Keep the implementation in a few focused modules: shared schemas/types, safe
errors, client evaluation, the private usage writer, and MCP startup.
`src/index.ts` exports the client, public types and `JevError`; it never imports
the startup module or MCP SDK. The adapter calls those public exports and imports
shared schemas for registration,
without reimplementing their rules. Internal helpers need no exported subpaths,
transport options or provider abstraction.

Build ESM JavaScript and declarations into `dist`. The package root export points
to the API and its types; `bin.jev-mcp` points to the built startup entry with a
Node shebang. Keep Zod and the MCP SDK as runtime dependencies and test tooling
as development dependencies. The packed artifact must contain every referenced
built module and install its dependencies; it must not rely on TypeScript source,
a source runner or workspace-relative imports. Keep the package private and do
not publish it in this increment.

Consumers construct questions, select evidence, interpret answers and own actions.
Their stage names, model ladders, thresholds, fallback rules and workflow state do
not belong here. Consumer context is provider input, never executable host code.

## Verification seams

Apply the boundary checks in [development](development.md#test-boundaries).
Client tests control fetch in the test process. Stdio and packed-consumer tests
launch the actual built executable with a test-only Node preload that intercepts
the fixed provider URL and routes it to a controlled loopback fixture server.
Keep native fetch and AbortSignal behavior for headers and body reading. Reject
unexpected network destinations, use synthetic credentials and copy the preload
into the temporary consumer for the installed-command check. The preload is test
infrastructure, never part of the package or a production environment option.

Share sanitized provider fixtures between API and MCP parity tests. Exercise the
full validation/failure matrix at the client boundary, and protocol formatting,
representative parity, startup and cancellation/EOF behavior through stdio. Test
the installed root exports and declarations from a clean temporary consumer and
initialize/call the installed executable there. This verifies the deliverable
without adding configurable endpoints, public transport injection or live access
to default validation. An opt-in live smoke remains the separate compatibility
check described in the development guide.
