export type JevErrorCode =
  | 'invalid_input'
  | 'authentication'
  | 'rate_limited'
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'invalid_response';

const MESSAGES: Record<JevErrorCode, string> = {
  invalid_input: 'The request is invalid.',
  authentication: 'Authentication failed.',
  rate_limited: 'The rate limit was exceeded.',
  timeout: 'The request timed out.',
  cancelled: 'The request was cancelled.',
  unavailable: 'The service is unavailable.',
  invalid_response: 'The provider response is invalid.',
};

export class JevError extends Error {
  readonly code: JevErrorCode;
  readonly status: number | undefined;

  constructor(code: JevErrorCode, status?: number) {
    super(MESSAGES[code]);
    this.name = 'JevError';
    this.code = code;
    this.status = status;
  }
}
