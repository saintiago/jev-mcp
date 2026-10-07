# API and MCP contracts

This document specifies the first implementation. The
[TypeSafe API reference](https://docs.typesafe.ai/api) owns provider wire schemas.
Use its documented System One endpoint and bearer authentication.

## Consumer journey

A TypeScript application imports the package, supplies credentials, submits
questions sharing one state and receives structured judgments or a safe error.
An MCP host supplies credentials through its environment, launches `jev-mcp`,
discovers `ask_jev` and submits the same request. Both consumers interpret the
answers and decide what action to take; the package supplies no decision policy.

## TypeScript API

Export `createJevClient(options)` returning a client with
`evaluate(request, { signal }?) -> Promise<JevResult>`, plus the public types and
`JevError`. Creating a client performs no network request.

Options: required nonempty `apiKey`; optional `model` (default `jev-1.13.0`) and
positive finite `timeoutMs` (default 10000). The endpoint is fixed to
`https://api.typesafe.ai/v1/systemone`. Applications supply credentials explicitly.

Requests contain `state` and a nonempty `questions` map. State and instructions
use JSON-compatible strings, objects or arrays. Support the provider's three modes:

- `choice`: named options with string/object/array/null descriptions, up to 255.
- `score`: 2–10 ordered rubric descriptions.
- `noul`: yes/no judgment with optional true/false descriptions.

Send one request containing all questions and the configured model. Preserve IDs
and option labels. Reject invalid input before network activity. Avoid limits or
coercions not required by this contract or the provider.

Return typed model, answers and token usage. Choice and score retain probabilities
and confidence; score also retains its legend. Noul returns a number from 0 to 1,
not a boolean. Follow the linked wire schemas for precise field types.

Validate successful responses against shared schemas and the corresponding request:
every requested question must have the matching answer type, and choice labels
must belong to its criteria. Reject missing/malformed answers. Preserve provider
values rather than rounding, recalculating or generating explanations. Tolerate
compatible extra provider fields without promising them as public API. Do not
require exact floating-point probability sums. Record sanitized representative
fixtures for all modes during implementation.

## Failures

`JevError.code` is one of `invalid_input`, `authentication`, `rate_limited`,
`timeout`, `cancelled`, `unavailable`, or `invalid_response`. Include an HTTP status
when available. Safe messages identify the category without credentials, state,
question text or raw provider bodies.

Map local validation and HTTP 422 to invalid_input, HTTP 401/403 to authentication,
429 to rate_limited, other unsuccessful HTTP responses and network failures to
unavailable. Invalid successful JSON/schema maps to invalid_response. Timeout and
caller cancellation are distinguishable. Timeout covers request and body read;
caller cancellation may end it sooner. Clean up timers and listeners. No automatic
retries or fallback calls initially; consumers own those policies.

## MCP

Provide a `jev-mcp` executable using stdio transport. Read `JEV_API_KEY`, optional
`JEV_MODEL` and `JEV_TIMEOUT_MS`, and create the client once. Invalid configuration
fails startup clearly without exposing secrets. Do not accept keys, endpoints or
local file paths as tool arguments.

Expose one `ask_jev` tool. Input is the API's state/questions request. Return the
API result as structured content, with JSON text for text-only clients. Tool
errors use MCP's error mechanism and the same safe code/message; protocol input
errors follow the SDK. Propagate cancellation to the client. Declare accurately
that it sends supplied evidence to TypeSafe and does not modify local files.

Tool guidance: narrow questions, explicit alternatives, only relevant evidence,
and batching for shared state. JEv provides judgments, not code or prose answers.
Use deterministic tools for arithmetic, counting and executable checks. Confidence
does not authorize bypassing required workflow steps.

An MCP host launches the built executable and inherits the provider key from its
environment. TypeScript consumers import the package root and pass credentials
explicitly. Examples use synthetic context and environment references, never keys.

## Acceptance examples

These examples apply to the contracts above. Provider responses use the linked
wire schemas; the descriptions below illustrate observable outcomes rather than
introducing another request or response format.

- **All modes and batching:** Given synthetic state describing a document, submit
  a choice question with `keep`/`revise` alternatives, a score question with three
  ordered rubric descriptions and a noul question asking whether it is relevant.
  One provider request carries all three question IDs and the configured model.
  With a valid response, the result preserves model, IDs, labels, probabilities,
  confidence, score legend and token usage. A noul value of `0.73` remains `0.73`.
- **Invalid requests:** An empty questions map, a choice with 256 options or a
  score with 11 rubric entries rejects with `invalid_input` without a provider
  request. A score with two valid rubric entries is accepted. Valid string,
  object and array state values are accepted without coercion.
- **Configuration and imports:** Importing the package and creating a valid
  client makes no network request. An empty API key or a nonpositive or nonfinite
  timeout is rejected before evaluation. Omitting model and timeout uses
  `jev-1.13.0` and 10000 ms.
- **Response validation:** If the batch response omits the score answer, returns
  the wrong answer type, selects a choice label outside `keep`/`revise`, or returns
  a noul value outside 0–1, evaluation rejects with `invalid_response`. Valid
  responses with compatible extra fields or floating-point probability sums
  slightly different from one remain acceptable; provider values are preserved.
- **Provider failures:** HTTP 422 yields `invalid_input`; 401 and 403 yield
  `authentication`; 429 yields `rate_limited`; HTTP 500 and a network failure yield
  `unavailable`. Malformed JSON in an HTTP success yields `invalid_response`.
  HTTP errors retain their status, and none causes an automatic second call.
- **Bounded calls:** A response whose headers arrive but whose body stalls past
  the configured timeout rejects with `timeout`. Caller cancellation before that
  deadline rejects with `cancelled` instead. Neither outcome triggers a retry or
  fallback request.
- **Safe failures:** With a synthetic key, state and question text that are
  recognizable in a controlled failure response, error messages and diagnostics
  contain none of those values or the raw provider body.
- **MCP equivalence:** A host initializes stdio and discovers exactly one tool,
  `ask_jev`. Calling it with choice, score and noul questions sharing one state
  and a provider fixture also used for the API produces the same result as
  structured content and JSON text. A provider 429
  produces an MCP tool error with the API's safe `rate_limited` code/message.
  Tool arguments cannot supply credentials, an endpoint or a local file path.
- **MCP lifecycle:** Missing `JEV_API_KEY` or an invalid `JEV_TIMEOUT_MS` causes a
  clear, secret-free startup failure. Cancelling an outstanding tool call cancels
  its provider call; closing the connection aborts outstanding calls. Successful
  operation and failures leave stdout containing only protocol messages.
