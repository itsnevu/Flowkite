// A value import, for `instanceof`. browser/views.ts has only `import type` statements, so this adds
// no runtime edge and cannot form a cycle. Matching on constructor.name instead would be fragile:
// names are not guaranteed to survive minification in a production Vite build.
import { URLNotAllowedError } from '../../browser/views';

export const LLM_FORBIDDEN_ERROR_MESSAGE =
  'Access denied (403 Forbidden). Please check:\n\n1. Your API key has the required permissions\n\n2. For Ollama: Set OLLAMA_ORIGINS=chrome-extension://* \nsee https://docs.ollama.com/faq';

export const EXTENSION_CONFLICT_ERROR_MESSAGE = `
  Cannot access a chrome-extension:// URL of different extension.
  
  This is likely due to conflicting extensions. Please use Flowkite in a new profile.`;

/**
 * Custom error class for chat model authentication errors
 */
export class ChatModelAuthError extends Error {
  /**
   * Creates a new ChatModelAuthError
   *
   * @param message - The error message
   * @param cause - The original error that caused this error
   */
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ChatModelAuthError';

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ChatModelAuthError);
    }
  }

  /**
   * Returns a string representation of the error
   */
  toString(): string {
    return `${this.name}: ${this.message}${this.cause ? ` (Caused by: ${this.cause})` : ''}`;
  }
}

export class ChatModelForbiddenError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ChatModelForbiddenError';

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ChatModelForbiddenError);
    }
  }

  /**
   * Returns a string representation of the error
   */
  toString(): string {
    return `${this.name}: ${this.message}${this.cause ? ` (Caused by: ${this.cause})` : ''}`;
  }
}

/**
 * Custom error class for chat model bad request errors (400)
 */
export class ChatModelBadRequestError extends Error {
  /**
   * Creates a new ChatModelBadRequestError
   *
   * @param message - The error message
   * @param cause - The original error that caused this error
   */
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ChatModelBadRequestError';

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ChatModelBadRequestError);
    }
  }

  /**
   * Returns a string representation of the error
   */
  toString(): string {
    return `${this.name}: ${this.message}${this.cause ? ` (Caused by: ${this.cause})` : ''}`;
  }
}

/**
 * Checks if an error is related to API authentication
 *
 * @param error - The error to check
 * @returns boolean indicating if it's an authentication error
 */
export function isAuthenticationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // Get the error message
  const errorMessage = error.message || '';

  // Get error name - sometimes error.name just returns "Error" for custom errors
  let errorName = error.name || '';

  // Try to extract the constructor name, which often contains the actual error type
  // This works better than error.name for many custom errors
  const constructorName = error.constructor?.name;
  if (constructorName && constructorName !== 'Error') {
    errorName = constructorName;
  }

  // Check if the error name indicates an authentication error
  if (errorName === 'AuthenticationError') {
    return true;
  }

  // Fallback: check the message for authentication-related indicators
  return (
    errorMessage.toLowerCase().includes('authentication') ||
    errorMessage.includes(' 401') ||
    errorMessage.toLowerCase().includes('api key')
  );
}

/**
 * Checks if an error is related 403 Forbidden
 *
 * @param error - The error to check
 * @returns boolean indicating if it's an 403 Forbidden error
 */
export function isForbiddenError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes(' 403') && error.message.includes('Forbidden');
}

/**
 * Checks if an error is related to 400 Bad Request
 *
 * @param error - The error to check
 * @returns boolean indicating if it's a 400 Bad Request error
 */
export function isBadRequestError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // Get the error message
  const errorMessage = error.message || '';

  // Get error name - sometimes error.name just returns "Error" for custom errors
  let errorName = error.name || '';

  // Try to extract the constructor name, which often contains the actual error type
  // This works better than error.name for many custom errors
  const constructorName = error.constructor?.name;
  if (constructorName && constructorName !== 'Error') {
    errorName = constructorName;
  }

  // Check if the error name indicates a bad request error
  if (errorName === 'BadRequestError') {
    return true;
  }

  // Check for specific patterns in the error message that indicate bad request
  return (
    errorMessage.includes(' 400') ||
    errorMessage.toLowerCase().includes('badrequest') ||
    errorMessage.includes('Invalid parameter') ||
    (errorMessage.includes('response_format') &&
      errorMessage.includes('json_schema') &&
      errorMessage.includes('not supported'))
  );
}

export function isAbortedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || error.message.includes('Aborted');
}

/**
 * Checks if an error is related to extension conflicts
 *
 * @param error - The error to check
 * @returns boolean indicating if it's an extension conflict error
 */
export function isExtensionConflictError(error: unknown): boolean {
  const errorMessage = (error instanceof Error ? error.message : String(error)).toLowerCase();

  return errorMessage.includes('cannot access a chrome-extension') && errorMessage.includes('of different extension');
}

/**
 * 4xx codes worth trying again. Everything else in 4xx is a statement about the request itself, and
 * an identical second request gets an identical answer.
 */
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);

/** Error names that mean the request never reached the model. */
const RETRYABLE_ERROR_NAMES = new Set(['APIConnectionError', 'APIConnectionTimeoutError', 'TimeoutError']);

/** Socket-level failures that surface on `code` rather than as an HTTP status. */
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * Pull the HTTP status out of a provider error, whichever shape it arrived in.
 *
 * LangChain hands the provider SDK's own error object straight through - `wrapOpenAIClientError`
 * and `wrapAnthropicClientError` both return the original for anything that is not a timeout or an
 * abort - so the status is still on it, under a different property per SDK: `status` for the
 * OpenAI, Anthropic, xAI, Groq, DeepSeek and Gemini clients, `status_code` for the Ollama client's
 * ResponseError. The message is deliberately never scraped for digits: OpenAI's own 429 body reads
 * "Limit 500, Used 500", which any such regex would classify as a 500.
 */
export function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { status?: unknown; status_code?: unknown; response?: { status?: unknown } };
  for (const value of [candidate.status, candidate.status_code, candidate.response?.status]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Whether calling the model again could plausibly succeed.
 *
 * Terminal is checked first and the default is terminal. A wrong "retryable" spends the user's rate
 * limit and delays the real error by the whole backoff budget; a wrong "terminal" costs one step,
 * which the executor's consecutive-failure handling already absorbs.
 */
export function isRetryableLLMError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // Cancellation, in every spelling it reaches us in. AsyncCaller.callWithOptions rejects with a
  // plain `new Error('AbortError')`, which isAbortedError does NOT catch: its name is 'Error' and
  // the string 'AbortError' does not contain 'Aborted'. That path is what Anthropic and Gemini use.
  if (isAbortedError(error) || error.message.startsWith('AbortError') || error.message.startsWith('Cancel')) {
    return false;
  }

  // A parse failure, a blocked URL or an exhausted quota all reproduce exactly on a second call.
  if (
    error instanceof RequestCancelledError ||
    error instanceof URLNotAllowedError ||
    error instanceof ResponseParseError ||
    isExtensionConflictError(error)
  ) {
    return false;
  }

  const status = extractStatusCode(error);
  if (status !== undefined) {
    // The status is authoritative whenever we have one. 529 is Anthropic's "overloaded", covered by
    // the 5xx arm. The message-shaped predicates below only exist for providers that give us none.
    return status >= 500 || RETRYABLE_STATUS_CODES.has(status);
  }

  if (isAuthenticationError(error) || isBadRequestError(error) || isForbiddenError(error)) {
    return false;
  }

  const constructorName = error.constructor?.name;
  const errorName = constructorName && constructorName !== 'Error' ? constructorName : error.name || '';
  if (RETRYABLE_ERROR_NAMES.has(errorName)) return true;

  const code = (error as { code?: unknown }).code ?? (error.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code)) return true;

  // What a service worker actually sees when a connection drops mid-request: fetch rejects with
  // `TypeError: Failed to fetch` and there is nothing else to go on.
  const message = error.message.toLowerCase();
  return (
    message.includes('failed to fetch') ||
    message.includes('fetch failed') ||
    message.includes('network error') ||
    message.includes('socket hang up') ||
    message.includes('overloaded')
  );
}

export class RequestCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestCancelledError';
  }
}

/**
 * The model asked for an element index that is not in the current page's map.
 *
 * Routine on dynamic pages - the snapshot goes stale between read and act - and self-healing: the
 * message is fed back to the model, which re-reads the page on its next step. Typed so the
 * navigator can log it as the warning it is instead of painting the console red.
 */
export class StaleElementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleElementError';
  }
}

export class ExtensionConflictError extends Error {
  /**
   * Creates a new ExtensionConflictError
   *
   * @param message - The error message
   * @param cause - The original error that caused this error
   */
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ExtensionConflictError';

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ExtensionConflictError);
    }
  }

  /**
   * Returns a string representation of the error
   */
  toString(): string {
    return `${this.name}: ${this.message}${this.cause ? ` (Caused by: ${this.cause})` : ''}`;
  }
}

/**
 * Custom error class for when maximum execution steps are reached
 */
export class MaxStepsReachedError extends Error {
  /**
   * Creates a new MaxStepsReachedError
   *
   * @param message - The localized error message (should use t('exec_errors_maxStepsReached'))
   * @param cause - The original error that caused this error
   */
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MaxStepsReachedError';

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MaxStepsReachedError);
    }
  }

  /**
   * Returns a string representation of the error
   */
  toString(): string {
    return `${this.name}: ${this.message}${this.cause ? ` (Caused by: ${this.cause})` : ''}`;
  }
}

/**
 * Custom error class for when maximum consecutive failures are reached
 */
export class MaxFailuresReachedError extends Error {
  /**
   * Creates a new MaxFailuresReachedError
   *
   * @param message - The localized error message (should use t('exec_errors_maxFailuresReached'))
   * @param cause - The original error that caused this error
   */
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MaxFailuresReachedError';

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MaxFailuresReachedError);
    }
  }

  /**
   * Returns a string representation of the error
   */
  toString(): string {
    return `${this.name}: ${this.message}${this.cause ? ` (Caused by: ${this.cause})` : ''}`;
  }
}

/**
 * Custom error class for when the history cannot be trimmed under the input token budget
 */
export class MaxTokensExceededError extends Error {
  /**
   * Creates a new MaxTokensExceededError
   *
   * @param message - The localized error message (should use t('exec_errors_contextTooLarge'))
   * @param cause - The original error that caused this error
   */
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MaxTokensExceededError';

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MaxTokensExceededError);
    }
  }

  /**
   * Returns a string representation of the error
   */
  toString(): string {
    return `${this.name}: ${this.message}${this.cause ? ` (Caused by: ${this.cause})` : ''}`;
  }
}

/**
 * Custom error class for when LLM response cannot be parsed into expected format
 */
export class ResponseParseError extends Error {
  /**
   * Creates a new ResponseParseError
   *
   * @param message - The error message describing the parsing failure
   * @param cause - The original error that caused this error
   */
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ResponseParseError';
  }

  /**
   * Returns a string representation of the error
   */
  toString(): string {
    return `${this.name}: ${this.message}${this.cause ? ` (Caused by: ${this.cause})` : ''}`;
  }
}
