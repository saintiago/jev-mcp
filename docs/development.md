# Development and delivery

Develop in WSL/Linux with Node 24, npm 11 and strict TypeScript ESM.
Run `npm ci` followed by `npm run validate`: formatting, types, build, provider transport tests,
repository boundaries, stdio protocol and clean packed consumption. Default checks use controlled
providers and synthetic credentials, never live paid calls.

Repository tests cover discovery, whole-file inspection, zero-provider literal lookup, path and
ignore boundaries, skipped content, coverage and cancellation. Transport tests own HTTP/schema,
deadline, cancellation and sanitized logging behavior. Stdio checks own the two-tool catalogue,
protocol results and lifecycle. Packing checks installed API declarations and the executable.

Live checks are explicit and use known repository targets plus no-match queries. Report recall
limits and provider usage. Do not add production options only to support tests.

Repository: saintiago/jev-mcp. Consumer integration and activation belong to Nexus. Follow an
explicit manual implementation request directly; otherwise use the configured Nexus workflow.
