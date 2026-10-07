# Tooling, testing and delivery

## Environment

Develop in WSL/Linux, Node.js 24, npm 11 and TypeScript ESM with strict checking.
Use native fetch, Zod for shared schemas and the maintained MCP TypeScript SDK.
Use Prettier and TypeScript checking; add Vitest with the implementation. Keep one
package and lockfile. No monorepo runner, database or container stack.

```sh
npm ci
npm run validate
```

`npm run validate` checks formatting, TypeScript, the build, client contracts,
stdio behavior and the packed consumer. It needs no provider credentials and
makes no live provider call. No empty placeholder tests or pass-with-no-tests
verification.

## Test boundaries

- Client contracts: every mode, batches, invalid inputs/responses, HTTP failures,
  cancellation and timeouts including body read. Use controlled transport/server
  fixtures; no live provider in default tests.
- MCP contract: initialize stdio, list/call the tool and check schema/result/error
  parity. Verify stdout remains protocol-only.
- Packaging: install a tarball into a clean temporary consumer, import its API,
  check exported types and launch the installed executable (`npm run test:packed`,
  included in `npm run validate`).
- Live smoke: explicit opt-in with `JEV_API_KEY`, small synthetic evidence and
  all modes. No private project text in fixtures.

Prefer boundary tests over internal-helper assertions. Do not repeat the full
validation suite through both interfaces. Consumer evaluations belong to consumers.

## First implementation acceptance

- With no provider credentials and no live provider access, `npm ci` followed by
  `npm run validate` checks formatting, TypeScript, build, client contracts, stdio
  behavior and the packed consumer. The behavioral examples are in
  [contracts](contracts.md#acceptance-examples).
- A clean temporary consumer installs the local tarball, imports
  `createJevClient`, `JevError` and the public types from `@saintiago/jev`, and
  launches the installed `jev-mcp` command. These checks work without the source
  checkout as an import or executable dependency and without npm publication.
- README reports the implemented availability and gives working synthetic
  examples for choice, score and noul evaluation, plus an MCP host launch using
  environment credentials. Its API and executable references work from the
  packed installation. It explains credential setup without including a key.

## Delivery

Jira: [JEV](https://malton-family.atlassian.net/jira/software/projects/JEV/boards/101).
Repository: [saintiago/jev-mcp](https://github.com/saintiago/jev-mcp).
WSL checkout: `/home/aiur/projects/jev-mcp`. Default branch: `main`.

`nexus.project.json` owns repository/check/Jira/delivery mappings. Credentials,
agent profiles, providers and workflow policy remain in the installed Nexus config.
The provider key stays in host configuration, never in this repository.

Use AMEM's idea, preparation and delivery mappings. There is no graphical UI:
UX or Storybook stages should record non-applicability through the configured
workflow, rather than creating screens or Storybook files. Nexus runs `npm ci`
and `npm run validate`. Do not duplicate these with GitHub Actions or post-merge
CI without a current need.

Manual bootstrap prepares docs, project metadata and Nexus configuration. The
initial Jira task delivers API, MCP and package verification together. Consumer
integration and rollout to agents follow separately in consumer/host configuration.

## Documentation ownership

Charter owns purpose/scope; architecture owns components/composition; contracts
owns observable behavior; this document owns tooling/testing/delivery. Update
the owner when intentionally changing behavior. README reports availability;
AGENTS is the index and contributor guidance.
