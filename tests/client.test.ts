import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJevClient, JevError } from '../src/index.js';
import type { JevRequest } from '../src/index.js';
import {
  batchRequest,
  batchResponse,
  structuredState,
  structuredStateRequest,
  structuredStateResponse,
} from './fixtures.js';
import {
  configError,
  failureOf,
  jsonResponse,
  sentRequest,
  stubFetch,
} from './support.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('module and configuration', () => {
  it('imports the root and constructs a client without network or provider environment reads', async () => {
    const fetchMock = stubFetch(() =>
      Promise.reject(new Error('network access')),
    );
    const importReads: string[] = [];
    const constructionReads: string[] = [];
    let recording = true;
    const originalEnv = process.env;
    Object.defineProperty(process, 'env', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: new Proxy(originalEnv, {
        get(target, property, receiver) {
          if (typeof property === 'string') {
            (recording ? importReads : constructionReads).push(property);
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    try {
      vi.resetModules();
      const module = await import('../src/index.js');
      recording = false;
      const client = module.createJevClient({ apiKey: 'synthetic-key' });
      expect(Object.keys(module).sort()).toEqual([
        'JevError',
        'createJevClient',
      ]);
      expect(typeof client.evaluate).toBe('function');
      expect(constructionReads).toEqual([]);
    } finally {
      Object.defineProperty(process, 'env', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: originalEnv,
      });
    }
    for (const key of ['JEV_API_KEY', 'JEV_MODEL', 'JEV_TIMEOUT_MS']) {
      expect(importReads).not.toContain(key);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty API key before evaluation', () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(batchResponse)),
    );
    expect(configError({ apiKey: '' }).code).toBe('invalid_input');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects nonpositive and nonfinite timeouts before evaluation', () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(batchResponse)),
    );
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(configError({ apiKey: 'synthetic-key', timeoutMs }).code).toBe(
        'invalid_input',
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty model', () => {
    expect(configError({ apiKey: 'synthetic-key', model: '' }).code).toBe(
      'invalid_input',
    );
  });

  it('constructs a valid client without network activity', () => {
    const fetchMock = stubFetch(() =>
      Promise.reject(new Error('network access')),
    );
    const client = createJevClient({ apiKey: 'synthetic-key' });
    expect(typeof client.evaluate).toBe('function');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('batching and all modes', () => {
  it('sends one authenticated request and preserves the batch result', async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(batchResponse)),
    );
    const client = createJevClient({ apiKey: 'synthetic-key' });

    const result = await client.evaluate(batchRequest);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init, body } = sentRequest(fetchMock);
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      Authorization: 'Bearer synthetic-key',
      'Content-Type': 'application/json',
    });
    expect(body.state).toBe(batchRequest.state);
    expect(body.model).toBe('jev-1.13.0');
    expect(body.questions).toEqual(batchRequest.questions);
    expect(Object.keys(body.questions)).toEqual([
      'keep_or_revise',
      'quality',
      'relevant',
    ]);
    expect(result).toEqual(batchResponse);
    expect(result.answers['relevant']).toEqual({ type: 'noul', noul: 0.73 });
  });

  it('sends the configured model', async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(batchResponse)),
    );
    const client = createJevClient({
      apiKey: 'synthetic-key',
      model: 'jev-1.12.0',
    });

    await client.evaluate(batchRequest);

    expect(sentRequest(fetchMock).body.model).toBe('jev-1.12.0');
  });

  it('tolerates compatible extra provider fields', async () => {
    const responseWithExtras = {
      model: 'jev-1.13.0',
      latency_ms: 42,
      answers: {
        keep_or_revise: {
          type: 'choice',
          choice: 'revise',
          probabilities: { keep: 0.24, revise: 0.76 },
          confidence: 0.71,
          provider_notes: ['synthetic'],
        },
        quality: {
          type: 'score',
          score: 1.05,
          legend: { '0': 'Poor', '1': 'Acceptable', '2': 'Excellent' },
          probabilities: { '0': 0.05, '1': 0.85, '2': 0.1 },
          confidence: 0.88,
          raw: { level: 1 },
        },
        relevant: {
          type: 'noul',
          noul: 0.73,
          alternatives: [0.27],
        },
      },
      usage: { input_tokens: 312, output_tokens: 26, cost_usd: 0.001 },
    };
    stubFetch(() => Promise.resolve(jsonResponse(responseWithExtras)));
    const client = createJevClient({ apiKey: 'synthetic-key' });

    const result = await client.evaluate(batchRequest);

    expect(result).toEqual(batchResponse);
  });

  it('tolerates deeply nested compatible extra provider fields', async () => {
    const nesting = 10000;
    const payload =
      '{"model":"jev-1.13.0","answers":{"relevant":{"type":"noul","noul":0.73}},"usage":{"input_tokens":1,"output_tokens":1},"extra":' +
      '['.repeat(nesting) +
      '0' +
      ']'.repeat(nesting) +
      '}';
    const request: JevRequest = {
      state: 'Synthetic state',
      questions: {
        relevant: { type: 'noul', instructions: 'Is the note relevant?' },
      },
    };
    stubFetch(() => Promise.resolve(new Response(payload, { status: 200 })));
    const client = createJevClient({ apiKey: 'synthetic-key' });

    const result = await client.evaluate(request);

    expect(result).toEqual({
      model: 'jev-1.13.0',
      answers: { relevant: { type: 'noul', noul: 0.73 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });

  it('accepts floating-point probability sums that are not exactly one', async () => {
    const response = {
      model: 'jev-1.13.0',
      answers: {
        keep_or_revise: {
          type: 'choice',
          choice: 'revise',
          probabilities: { keep: 0.24001, revise: 0.76002 },
          confidence: 0.71,
        },
      },
      usage: { input_tokens: 312, output_tokens: 26 },
    };
    stubFetch(() => Promise.resolve(jsonResponse(response)));
    const client = createJevClient({ apiKey: 'synthetic-key' });
    const request: JevRequest = {
      state: 'Synthetic state',
      questions: {
        keep_or_revise: {
          type: 'choice',
          instructions: 'Should the draft be kept or revised?',
          criteria: {
            keep: 'Send the draft as written',
            revise: 'Revise the draft before sending',
          },
        },
      },
    };

    const result = await client.evaluate(request);

    expect(result.answers['keep_or_revise']).toEqual(
      response.answers.keep_or_revise,
    );
  });

  it('validates and sends the submitted request snapshot', async () => {
    const request = structuredClone(batchRequest);
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(batchResponse)),
    );
    const client = createJevClient({ apiKey: 'synthetic-key' });

    const evaluation = client.evaluate(request);
    const questions = request.questions as Record<string, unknown>;
    delete questions['relevant'];
    questions['injected'] = {
      type: 'noul',
      instructions: 'Injected after submission.',
    };
    const result = await evaluation;

    expect(result).toEqual(batchResponse);
    expect(Object.keys(sentRequest(fetchMock).body.questions)).toEqual([
      'keep_or_revise',
      'quality',
      'relevant',
    ]);
  });

  it('accepts object and array state without coercion', async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(structuredStateResponse)),
    );
    const client = createJevClient({ apiKey: 'synthetic-key' });

    const result = await client.evaluate(structuredStateRequest);

    expect(sentRequest(fetchMock).body.state).toEqual(structuredState);
    expect(result).toEqual(structuredStateResponse);
  });

  it('accepts structured instructions and descriptions without coercion', async () => {
    const request: JevRequest = {
      state: { note: 'Synthetic state object' },
      questions: {
        pick: {
          type: 'choice',
          instructions: {
            question: 'Which option fits?',
            context: { locale: 'en' },
          },
          criteria: {
            first: { rubric: 'The first option', weight: 1 },
            second: null,
          },
        },
        rating: {
          type: 'score',
          instructions: ['Rate the note'],
          criteria: [{ level: 'Low' }, ['Medium'], 'High'],
        },
        yes_no: {
          type: 'noul',
          instructions: 'Is the note relevant?',
          criteria: { true: { label: 'Yes' }, false: ['No'] },
        },
      },
    };
    const response = {
      model: 'jev-1.13.0',
      answers: {
        pick: {
          type: 'choice',
          choice: 'first',
          probabilities: { first: 0.7, second: 0.3 },
          confidence: 0.6,
        },
        rating: {
          type: 'score',
          score: 1.2,
          legend: { '0': 'Low', '1': 'Medium', '2': 'High' },
          probabilities: { '0': 0.1, '1': 0.6, '2': 0.3 },
          confidence: 0.7,
        },
        yes_no: { type: 'noul', noul: 0.4 },
      },
      usage: { input_tokens: 64, output_tokens: 16 },
    };
    const fetchMock = stubFetch(() => Promise.resolve(jsonResponse(response)));
    const client = createJevClient({ apiKey: 'synthetic-key' });

    const result = await client.evaluate(request);

    expect(sentRequest(fetchMock).body.questions).toEqual(request.questions);
    expect(result).toEqual(response);
  });

  it('preserves arbitrary question ids and option labels', async () => {
    const protoKey = '__proto__';
    const prefixedKey = '\u0000__proto__';
    const request = {
      state: 'Synthetic state',
      questions: {
        [protoKey]: {
          type: 'choice',
          instructions: 'Pick the first or second option.',
          criteria: {
            [protoKey]: 'First option',
            [prefixedKey]: 'Second option',
          },
        },
        [prefixedKey]: {
          type: 'noul',
          instructions: 'Is the note relevant?',
        },
      },
    } as unknown as JevRequest;
    const response = {
      model: 'jev-1.13.0',
      answers: {
        [protoKey]: {
          type: 'choice',
          choice: prefixedKey,
          probabilities: { [protoKey]: 0.6, [prefixedKey]: 0.4 },
          confidence: 0.6,
        },
        [prefixedKey]: { type: 'noul', noul: 0.2 },
      },
      usage: { input_tokens: 12, output_tokens: 6 },
    };
    const fetchMock = stubFetch(() => Promise.resolve(jsonResponse(response)));
    const client = createJevClient({ apiKey: 'synthetic-key' });

    const result = await client.evaluate(request);

    const sentQuestions = sentRequest(fetchMock).body.questions;
    expect(Object.hasOwn(sentQuestions, protoKey)).toBe(true);
    expect(Object.hasOwn(sentQuestions, prefixedKey)).toBe(true);
    expect(JSON.stringify(sentQuestions)).toContain('"__proto__"');
    expect(Object.hasOwn(result.answers, protoKey)).toBe(true);
    expect(Object.hasOwn(result.answers, prefixedKey)).toBe(true);
    expect(result).toEqual({
      model: 'jev-1.13.0',
      answers: response.answers,
      usage: response.usage,
    });
  });
});

describe('invalid requests', () => {
  it('rejects an empty questions map without a provider request', async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(batchResponse)),
    );
    const client = createJevClient({ apiKey: 'synthetic-key' });

    const error = await failureOf(
      client.evaluate({ state: 'Synthetic state', questions: {} }),
    );

    expect(error.code).toBe('invalid_input');
    expect(error.status).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a choice with 255 options and rejects 256', async () => {
    const client = createJevClient({ apiKey: 'synthetic-key' });
    for (const count of [255, 256]) {
      const criteria: Record<string, string> = {};
      const probabilities: Record<string, number> = {};
      for (let index = 0; index < count; index += 1) {
        criteria[`option_${index}`] = `Option ${index}`;
        probabilities[`option_${index}`] = index === 0 ? 1 : 0;
      }
      const request = {
        state: 'Synthetic state',
        questions: {
          pick: {
            type: 'choice',
            instructions: 'Pick one option.',
            criteria,
          },
        },
      } as unknown as JevRequest;
      const response = {
        model: 'jev-1.13.0',
        answers: {
          pick: {
            type: 'choice',
            choice: 'option_0',
            probabilities,
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      const fetchMock = stubFetch(() =>
        Promise.resolve(jsonResponse(response)),
      );

      if (count === 255) {
        await expect(client.evaluate(request)).resolves.toEqual(response);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } else {
        const error = await failureOf(client.evaluate(request));
        expect(error.code).toBe('invalid_input');
        expect(fetchMock).not.toHaveBeenCalled();
      }
      vi.unstubAllGlobals();
    }
  });

  it('accepts a score with 2 levels and rejects 1 or 11', async () => {
    const client = createJevClient({ apiKey: 'synthetic-key' });
    for (const count of [1, 2, 11]) {
      const criteria = Array.from(
        { length: count },
        (_level, index) => `Level ${index}`,
      );
      const probabilities: Record<string, number> = {};
      const legend: Record<string, string> = {};
      for (let index = 0; index < count; index += 1) {
        probabilities[String(index)] = index === 0 ? 1 : 0;
        legend[String(index)] = `Level ${index}`;
      }
      const request = {
        state: 'Synthetic state',
        questions: {
          rating: {
            type: 'score',
            instructions: 'Rate the state.',
            criteria,
          },
        },
      } as unknown as JevRequest;
      const response = {
        model: 'jev-1.13.0',
        answers: {
          rating: {
            type: 'score',
            score: 0,
            legend,
            probabilities,
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      const fetchMock = stubFetch(() =>
        Promise.resolve(jsonResponse(response)),
      );

      if (count === 2) {
        await expect(client.evaluate(request)).resolves.toEqual(response);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } else {
        const error = await failureOf(client.evaluate(request));
        expect(error.code).toBe('invalid_input');
        expect(fetchMock).not.toHaveBeenCalled();
      }
      vi.unstubAllGlobals();
    }
  });

  it('rejects request values that are not JSON compatible', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const sparseArray = new Array<string>(2);
    const values: Array<[string, unknown]> = [
      ['null', null],
      ['a number', 42],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['undefined', undefined],
      ['a function', () => 'synthetic'],
      ['a date', new Date('2026-01-01T00:00:00Z')],
      ['a sparse array', sparseArray],
      ['a symbol key', { [Symbol('key')]: 'synthetic' }],
      ['a nested unsupported value', { nested: { value: Number.NaN } }],
      ['a cyclic object', cyclic],
    ];
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(batchResponse)),
    );
    const client = createJevClient({ apiKey: 'synthetic-key' });

    for (const [name, state] of values) {
      const request = {
        state,
        questions: {
          relevant: { type: 'noul', instructions: 'Is it relevant?' },
        },
      } as unknown as JevRequest;
      const error = await failureOf(client.evaluate(request));
      expect(error.code, name).toBe('invalid_input');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unknown question fields before a provider request', async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(batchResponse)),
    );
    const client = createJevClient({ apiKey: 'synthetic-key' });
    const request = {
      state: 'Synthetic state',
      questions: {
        relevant: {
          type: 'noul',
          instructions: 'Is it relevant?',
          unexpected: 'synthetic',
        },
      },
    } as unknown as JevRequest;

    const error = await failureOf(client.evaluate(request));

    expect(error.code).toBe('invalid_input');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('contains parser exceptions for deeply nested state as invalid_input', async () => {
    let state: JevRequest['state'] = 'Synthetic leaf';
    for (let depth = 0; depth < 2500; depth += 1) {
      state = { nested: state };
    }
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(batchResponse)),
    );
    const client = createJevClient({ apiKey: 'synthetic-key' });

    const error = await failureOf(
      client.evaluate({
        state,
        questions: {
          relevant: { type: 'noul', instructions: 'Is it relevant?' },
        },
      }),
    );

    expect(error).toBeInstanceOf(JevError);
    expect(error.code).toBe('invalid_input');
    expect(error.status).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('response validation', () => {
  function mutateResponse(
    mutate: (answers: Record<string, unknown>) => void,
  ): unknown {
    const answers: Record<string, unknown> = { ...batchResponse.answers };
    const response: Record<string, unknown> = { ...batchResponse, answers };
    mutate(answers);
    return response;
  }

  function replaceAnswer(
    answers: Record<string, unknown>,
    id: string,
    patch: Record<string, unknown>,
  ): void {
    answers[id] = { ...(answers[id] as Record<string, unknown>), ...patch };
  }

  const invalidResponses: Array<[string, unknown]> = [
    [
      'omits the score answer',
      mutateResponse((answers) => {
        delete answers['quality'];
      }),
    ],
    [
      'returns the wrong answer type',
      mutateResponse((answers) => {
        answers['quality'] = { type: 'noul', noul: 0.5 };
      }),
    ],
    [
      'selects a choice label outside the criteria',
      mutateResponse((answers) => {
        replaceAnswer(answers, 'keep_or_revise', { choice: 'discard' });
      }),
    ],
    [
      'omits a choice probability',
      mutateResponse((answers) => {
        replaceAnswer(answers, 'keep_or_revise', {
          probabilities: { keep: 1 },
        });
      }),
    ],
    [
      'adds an unknown choice probability',
      mutateResponse((answers) => {
        replaceAnswer(answers, 'keep_or_revise', {
          probabilities: { keep: 0.5, revise: 0.4, discard: 0.1 },
        });
      }),
    ],
    [
      'returns a choice probability outside 0 to 1',
      mutateResponse((answers) => {
        replaceAnswer(answers, 'keep_or_revise', {
          probabilities: { keep: 1.2, revise: -0.2 },
        });
      }),
    ],
    [
      'returns a noul value above 1',
      mutateResponse((answers) => {
        replaceAnswer(answers, 'relevant', { noul: 1.2 });
      }),
    ],
    [
      'returns a noul value below 0',
      mutateResponse((answers) => {
        replaceAnswer(answers, 'relevant', { noul: -0.1 });
      }),
    ],
    [
      'returns a boolean noul value',
      mutateResponse((answers) => {
        replaceAnswer(answers, 'relevant', { noul: true });
      }),
    ],
    [
      'returns a confidence outside 0 to 1',
      mutateResponse((answers) => {
        replaceAnswer(answers, 'quality', { confidence: 1.5 });
      }),
    ],
    [
      'omits a score legend level',
      mutateResponse((answers) => {
        replaceAnswer(answers, 'quality', {
          legend: { '0': 'Poor', '1': 'Acceptable' },
        });
      }),
    ],
    [
      'omits a score probability level',
      mutateResponse((answers) => {
        replaceAnswer(answers, 'quality', {
          probabilities: { '0': 0.1, '1': 0.9 },
        });
      }),
    ],
    [
      'returns a score above the levels',
      mutateResponse((answers) => {
        replaceAnswer(answers, 'quality', { score: 2.5 });
      }),
    ],
    [
      'returns a score below the levels',
      mutateResponse((answers) => {
        replaceAnswer(answers, 'quality', { score: -0.1 });
      }),
    ],
    [
      'adds an answer for an unknown question',
      mutateResponse((answers) => {
        answers['unknown'] = { type: 'noul', noul: 0.5 };
      }),
    ],
    [
      'reports non-integer token usage',
      { ...batchResponse, usage: { input_tokens: 1.5, output_tokens: 26 } },
    ],
  ];

  for (const [name, response] of invalidResponses) {
    it(`rejects a response that ${name}`, async () => {
      const fetchMock = stubFetch(() =>
        Promise.resolve(jsonResponse(response)),
      );
      const client = createJevClient({ apiKey: 'synthetic-key' });

      const error = await failureOf(client.evaluate(batchRequest));

      expect(error.code).toBe('invalid_response');
      expect(error.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  it('rejects a response that omits token usage', async () => {
    const { usage: _usage, ...response } = batchResponse;
    stubFetch(() => Promise.resolve(jsonResponse(response)));
    const client = createJevClient({ apiKey: 'synthetic-key' });

    const error = await failureOf(client.evaluate(batchRequest));

    expect(error.code).toBe('invalid_response');
  });

  it('rejects malformed JSON in a successful response', async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(new Response('{not json', { status: 200 })),
    );
    const client = createJevClient({ apiKey: 'synthetic-key' });

    const error = await failureOf(client.evaluate(batchRequest));

    expect(error.code).toBe('invalid_response');
    expect(error.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a successful response that is not an object', async () => {
    stubFetch(() => Promise.resolve(jsonResponse(['synthetic'])));
    const client = createJevClient({ apiKey: 'synthetic-key' });

    const error = await failureOf(client.evaluate(batchRequest));

    expect(error.code).toBe('invalid_response');
    expect(error.status).toBe(200);
  });
});
