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

## MCP adapter

Own process startup, environment configuration and the MCP protocol. Expose one
tool; delegate evaluation through the client's public contract. Use the maintained
MCP SDK and shared schemas. Stdout is protocol-only; safe diagnostics use stderr.
Closing the connection releases resources and aborts outstanding requests.

Its external interface is `ask_jev`, specified in [contracts](contracts.md). Only
the adapter reads process environment. It does not import client internals to
reproduce evaluation rules.

## Composition and ownership

The package entry point exports the client; the executable starts the adapter.
They share contract definitions. There is no shared service or durable state.
Every request supplies its own evidence.

Consumers construct questions, select evidence, interpret answers and own actions.
Their stage names, model ladders, thresholds, fallback rules and workflow state do
not belong here. Consumer context is provider input, never executable host code.
