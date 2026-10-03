/**
 * The auth header and the error mapping are the two things every screen depends
 * on and neither is visible in the UI when it is wrong: a missing header looks
 * like a server that is down, and a mis-mapped 401 looks like a sign-in that
 * silently does nothing.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { ApiError, request, REQUEST_TIMEOUT_MS } from "./client";
import { writeToken } from "./token";

/** A minimal Response stand-in; jsdom has no fetch. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request", () => {
  it("sends the stored token as a bearer header", async () => {
    writeToken("token-123");
    fetchMock.mockResolvedValue(jsonResponse({ unreadCount: 2 }));

    await request("/notifications/unread-count");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBe("Bearer token-123");
  });

  it("sends no header at all when there is no token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ unreadCount: 0 }));

    await request("/notifications/unread-count");

    const [, init] = fetchMock.mock.calls[0];
    // Not an empty string and not "Bearer null": the header is simply absent.
    expect(init.headers.authorization).toBeUndefined();
  });

  it("omits the token for the sign-in call", async () => {
    writeToken("stale-token");
    fetchMock.mockResolvedValue(jsonResponse({ token: "new", user: {} }));

    await request("/auth/sign-in", {
      method: "POST",
      body: { email: "a@b.test", password: "x" },
      anonymous: true,
    });

    const [, init] = fetchMock.mock.calls[0];
    // Otherwise a 401 from a wrong password would be sent with the expired
    // token attached, and the server would blame the token rather than the
    // password.
    expect(init.headers.authorization).toBeUndefined();
  });

  it("sets a content type only when there is a body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ unreadCount: 0 }));

    await request("/notifications/unread-count");
    expect(fetchMock.mock.calls[0][1].headers["content-type"]).toBeUndefined();

    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await request("/notifications/read-all", { method: "POST" });
    expect(fetchMock.mock.calls[1][1].headers["content-type"]).toBeUndefined();
  });

  it("turns a 401 into an ApiError the UI can branch on", async () => {
    fetchMock.mockResolvedValue(errorResponse(401, "unauthorized", "Nope."));

    const error = await request("/auth/session").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isUnauthorized).toBe(true);
    expect((error as ApiError).code).toBe("unauthorized");
    expect((error as ApiError).message).toBe("Nope.");
  });

  it("flags a 400 as a validation problem", async () => {
    fetchMock.mockResolvedValue(errorResponse(400, "validation_error", "Bad email."));

    const error = (await request("/auth/sign-in", { anonymous: true }).catch(
      (err: unknown) => err,
    )) as ApiError;

    expect(error.isValidation).toBe(true);
  });

  it("survives an error page that is not JSON", async () => {
    // A proxy in front of the API returning an HTML 502 is a real occurrence.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    } as unknown as Response);

    const error = (await request("/notifications").catch((err: unknown) => err)) as ApiError;

    // It must still be an ApiError with a usable message, not a SyntaxError
    // escaping from three components deep.
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.message).toContain("502");
  });

  it("reports an unreachable server without pretending it answered", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const error = (await request("/notifications").catch((err: unknown) => err)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.message).toContain("Could not reach the server");
  });

  it("returns undefined for a 204 rather than trying to parse a body", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => {
      throw new SyntaxError("no body");
    } } as unknown as Response);

    await expect(request("/devices/dev-1", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("always applies a timeout, because a hung request is worse than a failed one", () => {
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(30_000);
    // Long enough for Render's free tier to wake, which STACK.md puts at ~30s.
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it("builds the URL from VITE_API_URL", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ unreadCount: 0 }));

    await request("/notifications/unread-count");

    // VITE_API_URL supplies the /api/v1 prefix; the endpoint path does not repeat it.
// Getting this wrong yields /api/v1/api/v1/... which 404s only in production.
expect(fetchMock.mock.calls[0][0]).toBe("http://api.test/api/v1/notifications/unread-count");
  });
});