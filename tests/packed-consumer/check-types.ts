import { createJevClient, JevError } from '@saintiago/jev';
import type {
  JevAnswer,
  JevChoiceQuestion,
  JevClient,
  JevClientOptions,
  JevErrorCode,
  JevEvaluateOptions,
  JevNoulQuestion,
  JevRequest,
  JevResult,
  JevScoreQuestion,
  JevUsage,
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

const options: JevClientOptions = { apiKey: 'synthetic-api-key' };
const client: JevClient = createJevClient(options);
const evaluateOptions: JevEvaluateOptions = {
  signal: new AbortController().signal,
};

async function evaluate(): Promise<JevResult> {
  return await client.evaluate(request, evaluateOptions);
}

function answers(result: JevResult): JevAnswer[] {
  return Object.values(result.answers);
}

function usage(result: JevResult): JevUsage {
  return result.usage;
}

function failure(): JevError {
  return new JevError('invalid_input', 422);
}

function errorCode(error: JevError): JevErrorCode {
  return error.code;
}

export { answers, errorCode, evaluate, failure, usage };
