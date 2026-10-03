import { describe, expect, it } from "vitest";

import {
  clearToken,
  hasUsableToken,
  isTokenExpired,
  readToken,
  writeToken,
} from "./token";

/** Builds a JWT-shaped string. Not a real signature - nothing here verifies one. */
function tokenWith(expSeconds: number): string {
  const payload = btoa(JSON.stringify({ sub: "user-1", exp: expSeconds }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `header.${payload}.signature`;
}

describe("token storage", () => {
  it("round-trips a token", () => {
    writeToken("abc123");
    expect(readToken()).toBe("abc123");
  });

  it("reads null when nothing is stored", () => {
    expect(readToken()).toBeNull();
  });

  it("clears the token", () => {
    writeToken("abc123");
    clearToken();
    expect(readToken()).toBeNull();
  });
});

describe("isTokenExpired", () => {
  it("treats a token expiring in the future as usable", () => {
    const now = 1_000_000;
    const token = tokenWith(Math.floor(now / 1000) + 3600);

    expect(isTokenExpired(token, now)).toBe(false);
  });

  it("treats a token past its expiry as expired", () => {
    const now = 1_000_000;
    const token = tokenWith(Math.floor(now / 1000) - 1);

    expect(isTokenExpired(token, now)).toBe(true);
  });

  it("treats a token expiring within the margin as expired", () => {
    const now = 1_000_000;
    const token = tokenWith(Math.floor(now / 1000) + 5);

    // The point of the margin: a request that lands after the token lapses is
    // a 401, and flashing the signed-in UI first is worse than signing out a
    // few seconds early.
    expect(isTokenExpired(token, now)).toBe(true);
  });

  it("treats a token with no exp claim as not expired", () => {
    // The API is the authority on expiry. Refusing a token that merely omits
    // exp would sign out a user the server would have accepted.
    const payload = btoa(JSON.stringify({ sub: "user-1" }));
    expect(isTokenExpired(`header.${payload}.sig`, 1_000_000)).toBe(false);
  });

  it("treats an unparseable token as expired rather than throwing", () => {
    expect(isTokenExpired("not-a-jwt", 1_000_000)).toBe(true);
    expect(isTokenExpired("", 1_000_000)).toBe(true);
  });
});

describe("hasUsableToken", () => {
  it("is false with no token", () => {
    expect(hasUsableToken()).toBe(false);
  });

  it("is true for a fresh token", () => {
    writeToken(tokenWith(Math.floor(Date.now() / 1000) + 3600));
    expect(hasUsableToken()).toBe(true);
  });

  it("is false for a lapsed token", () => {
    writeToken(tokenWith(Math.floor(Date.now() / 1000) - 60));
    expect(hasUsableToken()).toBe(false);
  });
});