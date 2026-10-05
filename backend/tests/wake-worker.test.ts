import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ env: { WORKER_WAKE_URL: "" } }));

vi.mock("../src/config/env.js", () => ({ env: mocks.env }));
vi.mock("../src/lib/logger.js", () => ({ logger: { debug: vi.fn() } }));

import { resetWakeThrottleForTests, wakeWorker } from "../src/lib/wake-worker.js";

const fetchMock = vi.fn();

beforeEach(() => {
  resetWakeThrottleForTests();
  fetchMock.mockReset().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.env.WORKER_WAKE_URL = "";
});

describe("wakeWorker", () => {
  it("does nothing when no wake URL is configured", () => {
    wakeWorker();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("knocks at most once a minute", () => {
    mocks.env.WORKER_WAKE_URL = "https://worker.example/health";

    wakeWorker(1_000);
    wakeWorker(30_000);
    wakeWorker(61_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith("https://worker.example/health", expect.anything());
  });

  it("never throws when the worker is unreachable", async () => {
    mocks.env.WORKER_WAKE_URL = "https://worker.example/health";
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    expect(() => wakeWorker()).not.toThrow();
    await Promise.resolve();
  });
});
