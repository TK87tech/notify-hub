/**
 * Issue #25, the registration half of browser push.
 *
 * The failure this guards against is a hang, not an exception. Without a
 * `register()` call, `navigator.serviceWorker.ready` never settles, so
 * `DevicesPage` awaits forever: the button spins, no error is logged, and the
 * page's own tests still pass because they stub `ready` rather than exercising
 * registration. So these tests pin the exact arguments the browser needs - URL
 * and scope - and the reason registration is skipped outside production.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { registerServiceWorker } from "@/push/register-service-worker";

const SCOPE = "/";

interface RegistrationStub {
  getRegistration: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
}

function stubContainer(registration?: Partial<RegistrationStub>) {
  const container: RegistrationStub = {
    getRegistration: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockResolvedValue({}),
    ...registration,
  };

  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: container,
  });

  return container;
}

afterEach(() => {
  vi.unstubAllEnvs();
  Reflect.deleteProperty(navigator, "serviceWorker");
  vi.restoreAllMocks();
});

describe("registerServiceWorker", () => {
  it("registers /sw.js at root scope", async () => {
    vi.stubEnv("PROD", true);
    const container = stubContainer();

    await expect(registerServiceWorker()).resolves.toBe("registered");

    expect(container.register).toHaveBeenCalledExactlyOnceWith("/sw.js", { scope: SCOPE });
  });

  it("reports unsupported when the browser has no service workers", async () => {
    vi.stubEnv("PROD", true);
    const container = stubContainer();

    Reflect.deleteProperty(navigator, "serviceWorker");

    await expect(registerServiceWorker()).resolves.toBe("unsupported");
    expect(container.register).not.toHaveBeenCalled();
  });

  it("does nothing outside a production build", async () => {
    // The dev server serves modules a worker is not meant to cache, and a worker
    // holding on to them serves a stale build with no visible cause.
    vi.stubEnv("PROD", false);
    const container = stubContainer();

    await expect(registerServiceWorker()).resolves.toBe("skipped");
    expect(container.register).not.toHaveBeenCalled();
    expect(container.getRegistration).not.toHaveBeenCalled();
  });

  it("skips registration when a worker is already active", async () => {
    // Re-registering on every load is harmless but pointless, and the point of
    // checking is to leave an existing worker alone entirely.
    vi.stubEnv("PROD", true);
    const container = stubContainer({
      getRegistration: vi.fn().mockResolvedValue({ active: {} }),
    });

    await expect(registerServiceWorker()).resolves.toBe("already-registered");
    expect(container.register).not.toHaveBeenCalled();
  });

  it("registers when the scope has a registration that never activated", async () => {
    // This is the state right after a fresh install, which is precisely when the
    // worker is still needed.
    vi.stubEnv("PROD", true);
    const container = stubContainer({
      getRegistration: vi.fn().mockResolvedValue({ active: null }),
    });

    await expect(registerServiceWorker()).resolves.toBe("registered");
    expect(container.register).toHaveBeenCalledOnce();
  });

  it("swallows a rejected registration instead of taking the app down", async () => {
    // Nearly always https-on-localhost. The app renders fine without push, so
    // this must not reject - `main.tsx` fires this off with no handler.
    vi.stubEnv("PROD", true);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    stubContainer({
      register: vi.fn().mockRejectedValue(new Error("insecure context")),
    });

    await expect(registerServiceWorker()).resolves.toBe("failed");
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("swallows a rejected lookup", async () => {
    vi.stubEnv("PROD", true);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    stubContainer({
      getRegistration: vi.fn().mockRejectedValue(new Error("nope")),
    });

    await expect(registerServiceWorker()).resolves.toBe("failed");
  });
});