import type { JevRequest, JevResult } from '../src/index.js';

export const syntheticState =
  'Synthetic support note: payouts have been failing for three days.';

export const batchRequest: JevRequest = {
  state: syntheticState,
  questions: {
    keep_or_revise: {
      type: 'choice',
      instructions: 'Should the draft reply be kept or revised?',
      criteria: {
        keep: 'Send the draft as written',
        revise: 'Revise the draft before sending',
      },
    },
    quality: {
      type: 'score',
      instructions: 'Rate the draft reply along the rubric.',
      criteria: ['Poor', 'Acceptable', 'Excellent'],
    },
    relevant: {
      type: 'noul',
      instructions: 'Is the draft reply relevant to the note?',
      criteria: { true: 'Directly relevant', false: 'Not relevant' },
    },
  },
};

export const batchResponse: JevResult = {
  model: 'jev-1.13.0',
  answers: {
    keep_or_revise: {
      type: 'choice',
      choice: 'revise',
      probabilities: { keep: 0.24, revise: 0.76 },
      confidence: 0.71,
    },
    quality: {
      type: 'score',
      score: 1.05,
      legend: { '0': 'Poor', '1': 'Acceptable', '2': 'Excellent' },
      probabilities: { '0': 0.05, '1': 0.85, '2': 0.1 },
      confidence: 0.88,
    },
    relevant: {
      type: 'noul',
      noul: 0.73,
    },
  },
  usage: { input_tokens: 312, output_tokens: 26 },
};

export const structuredState: JevRequest['state'] = {
  ticket: { subject: 'Payout failure', days_open: 3 },
  tags: ['billing', 'urgent'],
};

export const structuredStateRequest: JevRequest = {
  state: structuredState,
  questions: {
    relevant: {
      type: 'noul',
      instructions: 'Is the ticket relevant?',
    },
  },
};

export const structuredStateResponse: JevResult = {
  model: 'jev-1.13.0',
  answers: {
    relevant: { type: 'noul', noul: 0.9 },
  },
  usage: { input_tokens: 120, output_tokens: 8 },
};
