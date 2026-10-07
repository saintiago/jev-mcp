import { z } from 'zod';

export type JevJson =
  string | number | boolean | null | JevJson[] | { [key: string]: JevJson };

export type JevData = string | { [key: string]: JevJson } | JevJson[];

const MAX_CHOICE_OPTIONS = 255;
const MIN_SCORE_LEVELS = 2;
const MAX_SCORE_LEVELS = 10;
export const FLOAT_TOLERANCE = 1e-9;
const KEY_ESCAPE_PREFIX = '\u0000';

const jsonValueSchema: z.ZodType<JevJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const dataSchema: z.ZodType<JevData> = z.union([
  z.string(),
  z.record(z.string(), jsonValueSchema),
  z.array(jsonValueSchema),
]);

const noulQuestionSchema = z.strictObject({
  type: z.literal('noul'),
  instructions: dataSchema,
  criteria: z
    .strictObject({
      true: dataSchema.optional(),
      false: dataSchema.optional(),
    })
    .optional(),
});

const choiceQuestionSchema = z.strictObject({
  type: z.literal('choice'),
  instructions: dataSchema,
  criteria: z
    .record(z.string(), z.union([dataSchema, z.null()]))
    .refine((criteria) => Object.keys(criteria).length <= MAX_CHOICE_OPTIONS),
});

const scoreQuestionSchema = z.strictObject({
  type: z.literal('score'),
  instructions: dataSchema,
  criteria: z.array(dataSchema).min(MIN_SCORE_LEVELS).max(MAX_SCORE_LEVELS),
});

export const jevQuestionSchema = z.discriminatedUnion('type', [
  noulQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema,
]);

export const jevRequestSchema = z.strictObject({
  state: dataSchema,
  questions: z
    .record(z.string(), jevQuestionSchema)
    .refine((questions) => Object.keys(questions).length > 0),
});

// The MCP SDK parses tool arguments with this schema before the handler runs;
// this copy keeps own `__proto__`/escape-prefixed keys that Zod's record and
// object parsing would otherwise drop. It shares the request definition, so
// discovery and validation stay those of `jevRequestSchema`.
export const jevToolRequestSchema = preserveJsonKeys(jevRequestSchema);

const probabilitySchema = z
  .number()
  .min(0)
  .max(1 + FLOAT_TOLERANCE);
const confidenceSchema = z
  .number()
  .min(0)
  .max(1 + FLOAT_TOLERANCE);

const noulAnswerSchema = z.object({
  type: z.literal('noul'),
  noul: z.number().min(0).max(1),
});

const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), probabilitySchema),
  confidence: confidenceSchema,
});

const scoreAnswerSchema = z.object({
  type: z.literal('score'),
  score: z.number(),
  legend: z.record(z.string(), z.string()),
  probabilities: z.record(z.string(), probabilitySchema),
  confidence: confidenceSchema,
});

export const jevAnswerSchema = z.discriminatedUnion('type', [
  noulAnswerSchema,
  choiceAnswerSchema,
  scoreAnswerSchema,
]);

export const jevResultSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), jevAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

export type JevNoulQuestion = z.infer<typeof noulQuestionSchema>;
export type JevChoiceQuestion = z.infer<typeof choiceQuestionSchema>;
export type JevScoreQuestion = z.infer<typeof scoreQuestionSchema>;
export type JevQuestion = z.infer<typeof jevQuestionSchema>;
export type JevRequest = z.infer<typeof jevRequestSchema>;
export type JevNoulAnswer = z.infer<typeof noulAnswerSchema>;
export type JevChoiceAnswer = z.infer<typeof choiceAnswerSchema>;
export type JevScoreAnswer = z.infer<typeof scoreAnswerSchema>;
export type JevAnswer = z.infer<typeof jevAnswerSchema>;
export type JevResult = z.infer<typeof jevResultSchema>;
export type JevUsage = JevResult['usage'];

function escapeKey(key: string): string {
  return key === '__proto__' || key.startsWith(KEY_ESCAPE_PREFIX)
    ? KEY_ESCAPE_PREFIX + key
    : key;
}

function restoreKey(key: string): string {
  return key.startsWith(KEY_ESCAPE_PREFIX)
    ? key.slice(KEY_ESCAPE_PREFIX.length)
    : key;
}

interface KeyMapFrame {
  source: Record<string, unknown>;
  target: object;
  keys: string[];
  index: number;
}

function defineEntry(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function mapKeys(value: unknown, transform: (key: string) => string): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const root = Array.isArray(value) ? [] : {};
  const ancestors = new Set<object>([value]);
  const stack: KeyMapFrame[] = [
    {
      source: value as Record<string, unknown>,
      target: root,
      keys: Object.keys(value),
      index: 0,
    },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) {
      break;
    }
    if (frame.index >= frame.keys.length) {
      ancestors.delete(frame.source);
      stack.pop();
      continue;
    }
    const key = frame.keys[frame.index];
    frame.index += 1;
    if (key === undefined) {
      continue;
    }
    const child = frame.source[key];
    if (child !== null && typeof child === 'object') {
      if (ancestors.has(child)) {
        throw new Error('cyclic value');
      }
      ancestors.add(child);
      const target = Array.isArray(child) ? [] : {};
      defineEntry(frame.target, transform(key), target);
      stack.push({
        source: child as Record<string, unknown>,
        target,
        keys: Object.keys(child),
        index: 0,
      });
    } else {
      defineEntry(frame.target, transform(key), child);
    }
  }
  return root;
}

function preserveJsonKeys<T extends z.ZodType>(schema: T): T {
  const clone = schema.clone();
  const run = clone._zod.run;
  clone._zod.run = (payload, ctx) => {
    const escaped = run(
      { ...payload, value: mapKeys(payload.value, escapeKey) },
      ctx,
    );
    if (escaped instanceof Promise) {
      return escaped.then((settled) => ({
        ...settled,
        value: mapKeys(settled.value, restoreKey),
      }));
    }
    return { ...escaped, value: mapKeys(escaped.value, restoreKey) };
  };
  return clone;
}

export function parseJsonValue<T>(
  schema: z.ZodType<T>,
  value: unknown,
): T | undefined {
  try {
    const parsed = schema.safeParse(mapKeys(value, escapeKey));
    if (!parsed.success) {
      return undefined;
    }
    return mapKeys(parsed.data, restoreKey) as T;
  } catch {
    return undefined;
  }
}
