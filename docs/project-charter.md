# Purpose and scope

Give applications and agents one small way to ask TypeSafe JEv for structured
judgments. Follow AMEM's independent package and agent adapter pattern without
its storage or shared-service infrastructure.

## Initial scope

- Typed asynchronous TypeScript API for choice, score and noul questions.
- Multiple questions over one supplied state in one provider request.
- A stdio MCP command exposing the same capability as one `ask_jev` tool.
- Shared validation, bounded requests and predictable errors.
- A package artifact that applications import and MCP hosts launch.

No database, local model, HTTP server, durable queue, cache, provider framework,
automatic fallback model or application-specific routing. Do not publish to npm
as part of bootstrap or first implementation.

## Applications and boundaries

Agents can request a structured second assessment of explicit alternatives.
Applications can assess stage applicability, classify intent or judge context
relevance. Batch related questions sharing evidence.

These are consumer uses of a general contract, not separate package features.
Nexus owns stage applicability rules and can use JEv as decision evidence.
Required checks and explicit workflow invariants remain deterministic. A judgment
cannot override them. Unavailable or ambiguous results follow the consumer's
documented fallback rather than silently skipping work.

Confidence describes the provider distribution, not verified correctness. A fast
JEv call does not prove a faster workflow. Consumer changes need representative
outcome and latency comparisons including the added call. Initial developer
selection is a separate Nexus experiment, not the definition of this package.

## First increment complete

A fresh consumer can import the packed API and call every supported question type.
An MCP host can launch the packed command and obtain equivalent results.
Contract and stdio tests pass without credentials. A small opt-in live smoke call
can confirm provider compatibility. Consumer integration remains in its own repo.
