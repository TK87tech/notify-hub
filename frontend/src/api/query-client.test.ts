import { afterEach, describe, expect, it } from "vitest";

import { ApiError } from "./client";
import { handleRejectedToken } from "./query-client";
import { clearToken, readToken, writeToken } from "./token";

function unauthorized(sentToken: string | null): ApiError {
  const error = new ApiError(401, "unauthorized", "Token is not valid");
  error.sentToken = sentToken;
  return error;
}

afterEach(() => clearToken());

describe("handleRejectedToken", () => {
  it("signs out when the token in use is rejected", () => {
    writeToken("current");

    handleRejectedToken(unauthorized("current"));

    expect(readToken()).toBeNull();
  });

  it("ignores a late 401 for a request sent before this session existed", () => {
    // The anonymous session check from page load, answering after sign-up.
    writeToken("fresh-from-sign-up");

    handleRejectedToken(unauthorized(null));
    handleRejectedToken(unauthorized("older-token"));

    expect(readToken()).toBe("fresh-from-sign-up");
  });
});
