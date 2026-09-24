/**
 * Every error the API returns has the shape defined in contracts/openapi.yaml:
 *
 *   { "error": { "code": "not_found", "message": "Notification not found" } }
 *
 * Throw an ApiError anywhere and the error handler turns it into that shape
 * with the right status. Never send an error response by hand - it is how the
 * two sides drift apart.
 */

/** The codes the contract uses. Add one here before using it. */
export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unprocessable"
  | "rate_limited"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  rate_limited: 429,
  internal: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Optional field-level detail, used for validation failures. */
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
    Error.captureStackTrace?.(this, ApiError);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

// Shorthands, so route code reads as prose.
export const badRequest = (m: string, d?: unknown) => new ApiError("bad_request", m, d);
export const unauthorized = (m = "Authentication required") => new ApiError("unauthorized", m);
export const forbidden = (m = "You do not have access to this") => new ApiError("forbidden", m);
export const notFound = (m = "Not found") => new ApiError("not_found", m);
export const conflict = (m: string) => new ApiError("conflict", m);
export const unprocessable = (m: string, d?: unknown) => new ApiError("unprocessable", m, d);
