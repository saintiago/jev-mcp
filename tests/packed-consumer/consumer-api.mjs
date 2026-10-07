import { readFile } from 'node:fs/promises';
import { createJevClient, JevError } from '@saintiago/jev';

const request = JSON.parse(
  await readFile(new URL('./request.json', import.meta.url), 'utf8'),
);

const client = createJevClient({ apiKey: process.env.JEV_API_KEY });
const result = await client.evaluate(request);

const failure = new JevError('invalid_input', 422);
const rejection = await client
  .evaluate({ state: 'synthetic evidence', questions: {} })
  .then(
    () => null,
    (error) =>
      error instanceof JevError
        ? { code: error.code, status: error.status ?? null }
        : null,
  );

process.stdout.write(
  JSON.stringify({
    packageUrl: import.meta.resolve('@saintiago/jev'),
    result,
    rejection,
    error: {
      name: failure.name,
      isError: failure instanceof Error,
      code: failure.code,
      status: failure.status ?? null,
      message: failure.message,
    },
  }) + '\n',
);
