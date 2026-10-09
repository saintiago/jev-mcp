# JEv repository evidence

Batched repository evidence for coding agents, using ripgrep and TypeSafe JEv.

- `retrieve_evidence`: a question, scope and optional literal terms return exact source windows
  from several files, with original line bounds and explicit omissions.
- `expand_evidence`: retrieve several exact ranges or complete files without JEv filtering.

The previous `search_repo`, `inspect_files` and `ask_jev` interfaces are not exposed. No generated
explanations, autonomous investigation, correctness adjudication or silent shell filtering.

```ts
import { createJevClient, createRepositoryClient } from '@saintiago/jev';
const repo = createRepositoryClient(
  createJevClient({ apiKey: process.env.JEV_API_KEY! }),
  '.',
);
const evidence = await repo.retrieveEvidence({
  scope: 'src',
  terms: ['getUserMedia'],
});
const expanded = await repo.expandEvidence({
  requests: [{ path: 'src/camera.ts', full: true }],
});
```

Build with `npm ci && npm run validate`; start `JEV_API_KEY=... node dist/mcp.js` in the target Git
checkout. Optional local metadata logs: `JEV_USAGE_LOG_PATH` and `JEV_RETRIEVAL_LOG_PATH`.
See [contracts](docs/contracts.md), [architecture](docs/architecture.md),
[scope](docs/project-charter.md) and [development](docs/development.md).
