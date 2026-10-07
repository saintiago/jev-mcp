# JEv

A small TypeScript package for TypeSafe JEv structured judgments, with a thin
`ask_jev` MCP adapter for agents.

**Status:** implemented and verifiable from this repository. `npm ci` followed by
`npm run validate` checks formatting, TypeScript, the build, client contracts,
stdio behavior and the packed consumer without provider credentials or live
provider access. The package is `private` and unpublished in this increment;
install it from a packed tarball or the repository checkout.

Start with [AGENTS.md](AGENTS.md) and the [project charter](docs/project-charter.md).
See [contracts](docs/contracts.md) and [development](docs/development.md).

## Install

```sh
npm ci
npm run build
npm pack
```

`npm pack` writes a tarball such as `saintiago-jev-0.0.0.tgz`. Install it into a
consumer with `npm install /path/to/saintiago-jev-0.0.0.tgz`. The npm package is
`@saintiago/jev`; the repository directory remains `jev-mcp`.

## TypeScript API

`createJevClient(options)` returns a client with
`evaluate(request, { signal }?) -> Promise<JevResult>`. Credentials are supplied
explicitly; creating a client makes no network request. `model` defaults to
`jev-1.13.0` and `timeoutMs` to 10000 ms.

One request carries every question over one supplied state. The example below
uses the three supported modes with synthetic evidence:

```ts
import { createJevClient, JevError } from '@saintiago/jev';
import type {
  JevChoiceQuestion,
  JevNoulQuestion,
  JevRequest,
  JevScoreQuestion,
} from '@saintiago/jev';

const choice: JevChoiceQuestion = {
  type: 'choice',
  instructions: 'Should the draft reply be kept or revised?',
  criteria: {
    keep: 'Send the draft as written',
    revise: 'Revise the draft before sending',
  },
};

const score: JevScoreQuestion = {
  type: 'score',
  instructions: 'Rate the draft reply along this rubric.',
  criteria: ['Poor', 'Acceptable', 'Excellent'],
};

const noul: JevNoulQuestion = {
  type: 'noul',
  instructions: 'Is the draft reply relevant to the note?',
  criteria: { true: 'Directly relevant', false: 'Not relevant' },
};

const request: JevRequest = {
  state: 'Synthetic support note: payouts have been failing for three days.',
  questions: {
    reply_choice: choice,
    reply_quality: score,
    reply_relevant: noul,
  },
};

const apiKey = process.env.JEV_API_KEY;
if (apiKey === undefined) {
  throw new Error('JEV_API_KEY is required');
}
const client = createJevClient({ apiKey });

try {
  const result = await client.evaluate(request);
  console.log(result.model, result.answers.reply_relevant);
} catch (error) {
  if (error instanceof JevError) {
    console.error(error.code, error.message);
  }
}
```

The result keeps the provider's model, answers, probabilities, confidence, score
legend and token usage. Choice answers name the selected label, score answers
carry `score` with its legend, and noul answers carry a number from 0 to 1.
Failures surface as `JevError` with a code of `invalid_input`, `authentication`,
`rate_limited`, `timeout`, `cancelled`, `unavailable` or `invalid_response`, plus
the HTTP status when available. There are no automatic retries; consumers own
fallback policy. Pass an `AbortSignal` to cancel an evaluation.

## MCP

The packed package installs the `jev-mcp` executable, which speaks MCP over
stdio and exposes one `ask_jev` tool. Launch the executable inside the consumer
installation, where `/path/to/consumer` is the directory you installed the
tarball into:

```sh
JEV_API_KEY=... /path/to/consumer/node_modules/.bin/jev-mcp
```

`npx jev-mcp` also resolves the executable when run from the consumer directory
itself, but not elsewhere: the package is private and unpublished.

An MCP host launches that installed path and supplies credentials through its
environment. Use the absolute path because the host may start from any working
directory:

```json
{
  "mcpServers": {
    "jev": {
      "command": "/path/to/consumer/node_modules/.bin/jev-mcp",
      "env": { "JEV_API_KEY": "<your TypeSafe key>" }
    }
  }
}
```

`JEV_MODEL` (default `jev-1.13.0`) and `JEV_TIMEOUT_MS` (default 10000) are
optional. `ask_jev` takes the same state/questions request as the API and sends
the supplied evidence to TypeSafe. Tool arguments cannot supply credentials, an
endpoint or a file path. The implemented adapter does not modify local files;
the requested opt-in usage logging is specified in the
[contracts](docs/contracts.md#local-usage-logging) and awaits implementation with
enablement and file-location instructions.

## Credentials and live calls

Default validation never contacts the provider: it uses synthetic evidence and a
controlled fixture transport. The examples above make a live call only when you
run them with a real `JEV_API_KEY` for a TypeScript consumer, or set it in the
host environment for `jev-mcp`. Keys are never logged, stored or included in
error messages, and this repository contains none.

## Development

```sh
npm ci
npm run validate
```

`npm run validate` runs formatting, TypeScript, the build, client contract
tests, stdio tests and the packed-consumer check. The packed check installs the
local tarball into a clean temporary consumer, imports the root API and public
declarations, evaluates a synthetic batch with all three modes, and launches the
installed `jev-mcp` command against a fixture provider. It needs no npm
publication and no provider access.
