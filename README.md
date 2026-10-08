# JEv repository tools

Repository discovery and whole-file screening through TypeSafe JEv. No generative LLM.

- `search_repo({query, scope?, limit?})` returns ranked file paths and coverage.
- `inspect_files({paths, questions:[{id,question}]})` returns typed per-file assessments.

Agents read selected whole files themselves. Results contain no source excerpts or generated
reasons. Scores are advisory; negative results do not establish absence or bug freedom.
Conceptual search screens candidates then validates whole files, so coverage can be incomplete.

## TypeScript

```ts
import { createJevClient, createRepositoryClient } from '@saintiago/jev';
const repo = createRepositoryClient(
  createJevClient({ apiKey: process.env.JEV_API_KEY! }),
  process.cwd(),
);
const result = await repo.searchRepo({
  query: 'Where does the browser open its camera?',
  scope: 'src',
});
```

## MCP

Install the packed package and launch `jev-mcp` with the repository working directory and
`JEV_API_KEY` inherited from host configuration. It advertises exactly `search_repo` and
`inspect_files`. Optional `JEV_USAGE_LOG_PATH` enables sanitized usage metadata.

Run `npm ci && npm run validate` in WSL. Package consumption uses `npm pack`, without npm
publication. [Contracts](docs/contracts.md) own tool shapes, limits and error behavior.
