# JEv

A small TypeScript package for TypeSafe JEv structured judgments, with a thin
`ask_jev` MCP adapter for agents. Nexus can import the same API directly.

**Status:** project bootstrap and guiding documents. Product implementation is
queued in [Jira JEV](https://malton-family.atlassian.net/jira/software/projects/JEV/boards/101).
The API and MCP command described in the docs are intended contracts, not yet
available functionality.

Start with [AGENTS.md](AGENTS.md) and the [project charter](docs/project-charter.md).
See [contracts](docs/contracts.md) and [development](docs/development.md).

```sh
npm ci
npm run validate
```

The directory remains `jev-mcp`; the package serves TypeScript consumers and MCP
hosts. No shared HTTP service is required.
