/**
 * The one place that talks to the network.
 *
 * Every endpoint the browser uses goes through `request`, which means the auth
 * header, the error shape and the timeout are decided once rather than per call
 * site. A screen that forgets the Authorization header is a bug this file makes
 * impossible rather than one a reviewer has to catch.
 */

import { readToken } from "./token";
import type { ApiErrorCode } from "./types";

/**
 * Includes `/api/v1`, because the contract's `servers[0].url` is
 * `http://localhost:4000/api/v1` - the version prefix is part of the server
 * URL, not part of each path. VITE_API_URL is expected to carry the same shape
 * in every environment.
 */
const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api/v1";

/** Strips a trailing slash so `${BASE_URL}${path}` never produces `//`. */
const BASE = BASE_URL.replace(/\/+$/, "");

/**
 * Long enough that a cold Render free-tier instance can wake up, short enough
 * that a hung request does not leave a spinner on screen forever.
 *
 * STACK.md warns that Render sleeps after 15 minutes and takes roughly 30s to
 * wake. 45s leaves room for that; a shorter timeout would fail every request
 * made in the first minute after the service sleeps, which is exactly when
 * somebody opens the app to demo it.
 */
export const REQUEST_TIMEOUT_MS = 45_000;

/**
 * A non-2xx response, carrying the API's own error code and message.
 *
 * Extending Error rather than returning a bare object is what lets TanStack
 * Query's `error instanceof ApiError` narrow correctly in a catch block.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  /**
   * The bearer token the failed request carried (null when it had none). A 401
   * only means "this token is no good" - not "sign the user out" - so the
   * sign-out handler compares this with the token held now.
   */
  sentToken: string | null = null;

  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** True when signing in again is the only way forward. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** True when the caller sent something the API would not accept. */
  get isValidation(): boolean {
    return this.status === 400 || this.status === 422;
  }
}

interface RequestOptions {
  /** PUT is used by /preferences, which replaces the whole document. */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Skip the bearer token, for the public sign-in route. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

/**
 * Fetches JSON and turns every failure into an ApiError.
 *
 * A network failure, a timeout and a non-JSON error page all have to end up as
 * something a screen can show, because a screen cannot render `undefined`. The
 * response body is read defensively: a proxy returning an HTML 502 is a real
 * occurrence, not a hypothetical, and `response.json()` on it throws.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, anonymous = false, signal } = options;

  const headers: Record<string, string> = { accept: "application/json" };

  if (body !== undefined) headers["content-type"] = "application/json";

  const token = anonymous ? null : readToken();

  if (token) headers.authorization = `Bearer ${token}`;

  // A caller-supplied signal (TanStack Query passes one) and a timeout are
  // combined rather than replacing each other: the timeout stops a wedged
  // request, the caller's signal stops an unmounted one.
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;

  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined,
    });
  } catch (err) {
    // AbortSignal.any rejects with the reason from whichever signal fired, so
    // this covers both "the component went away" and "we waited too long".
    if (signal?.aborted) throw err;

    if (timeout.aborted) {
      throw new ApiError(
        503,
        "timeout",
        "The server took too long to answer. It may be waking up - try again in a moment.",
      );
    }

    throw new ApiError(
      0,
      "network_error",
      `Could not reach the server at ${BASE_URL}.`,
    );
  }

  if (!response.ok) {
    const details = await readErrorBody(response);

    const error = new ApiError(
      response.status,
      details.code ?? `http_${response.status}`,
      details.message ?? defaultMessage(response.status),
    );

    error.sentToken = token;

    throw error;
  }

  // 204 and friends have no body; anything else must be JSON or the contract
  // is wrong and it is better to hear about it here than three components deep.
  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

async function readErrorBody(response: Response): Promise<{ code?: string; message?: string }> {
  try {
    const body = (await response.json()) as ErrorBody;

    return { code: body.error?.code, message: body.error?.message };
  } catch {
    return {};
  }
}

function defaultMessage(status: number): string {
  if (status === 401) return "Your session has expired. Sign in again.";
  if (status === 403) return "You do not have access to that.";
  if (status === 404) return "That no longer exists.";
  if (status === 429) return "Too many attempts. Wait a moment and try again.";

  return `The server returned ${status}.`;
}

export { BASE_URL };