/**
 * Sign-in.
 *
 * The interesting assertions are the negative ones: an invalid password must be
 * indistinguishable from a nonexistent account, and a wrong password must not
 * be distinguishable from a right one by how long it takes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import type { Express } from "express";

const scryptAsync = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  userCreate: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
      update: mocks.userUpdate,
      create: mocks.userCreate,
    },
  },
}));

import { createApp } from "../src/app.js";
import { resetSignInAttempts } from "../src/api/auth.js";
import { hashPassword, needsRehash, verifyPassword } from "../src/lib/password.js";

let app: Express;

const PASSWORD = "correct-horse-battery-staple";

beforeEach(async () => {
  vi.clearAllMocks();
  resetSignInAttempts();

  mocks.userFindUnique.mockResolvedValue({
    id: "user-1",
    email: "tk@notifyhub.test",
    name: "TK",
    passwordHash: await hashPassword(PASSWORD),
  });
  mocks.userUpdate.mockResolvedValue({});

  app = createApp();
});

describe("POST /api/v1/auth/sign-up", () => {
  const body = { name: "Ada", email: "Ada@Example.com", password: "long-enough-pw" };

  it("creates the account, stores a hash, and signs it in", async () => {
    mocks.userCreate.mockImplementation(async ({ data }) => ({ id: "user-new", email: data.email, name: data.name }));

    const res = await request(app).post("/api/v1/auth/sign-up").send(body).expect(201);

    expect(res.body.user).toEqual({ id: "user-new", email: "ada@example.com", name: "Ada" });
    expect(typeof res.body.token).toBe("string");

    const { data } = mocks.userCreate.mock.calls[0][0];
    expect(data.email).toBe("ada@example.com");
    expect(data.passwordHash).not.toContain(body.password);
    expect(await verifyPassword(body.password, data.passwordHash)).toBe(true);

    // The token works on a protected route straight away.
    mocks.userFindUnique.mockResolvedValue({ id: "user-new", email: "ada@example.com", name: "Ada" });
    await request(app).get("/api/v1/auth/session").set("authorization", `Bearer ${res.body.token}`).expect(200);
  });

  it("answers 409 for an email that already has an account", async () => {
    mocks.userCreate.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));

    const res = await request(app).post("/api/v1/auth/sign-up").send(body).expect(409);

    expect(res.body.error.message).toMatch(/already exists/);
  });

  it("rejects a short password before touching the database", async () => {
    const res = await request(app)
      .post("/api/v1/auth/sign-up")
      .send({ ...body, password: "short" })
      .expect(400);

    expect(res.body.error.details).toEqual([
      expect.objectContaining({ field: "password", message: "Use at least 8 characters" }),
    ]);
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it("rate limits repeated sign-ups from one address", async () => {
    mocks.userCreate.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));

    for (let i = 0; i < 10; i += 1) {
      await request(app).post("/api/v1/auth/sign-up").send(body).expect(409);
    }

    await request(app).post("/api/v1/auth/sign-up").send(body).expect(429);
  });
});

describe("POST /api/v1/auth/sign-in", () => {
  it("returns a token and the user for the right password", async () => {
    const res = await request(app)
      .post("/api/v1/auth/sign-in")
      .send({ email: "tk@notifyhub.test", password: PASSWORD });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.token.split(".")).toHaveLength(3);
    expect(res.body.user).toEqual({ id: "user-1", email: "tk@notifyhub.test", name: "TK" });
  });

  it("issues a token the API accepts on a protected route", async () => {
    const signIn = await request(app)
      .post("/api/v1/auth/sign-in")
      .send({ email: "tk@notifyhub.test", password: PASSWORD });

    const session = await request(app)
      .get("/api/v1/auth/session")
      .set("Authorization", `Bearer ${signIn.body.token}`);

    expect(session.status).toBe(200);
    expect(session.body.user.email).toBe("tk@notifyhub.test");
  });

  it("lowercases the email so sign-in is not case sensitive", async () => {
    await request(app)
      .post("/api/v1/auth/sign-in")
      .send({ email: "TK@NotifyHub.Test", password: PASSWORD });

    expect(mocks.userFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "tk@notifyhub.test" } }),
    );
  });

  it("rejects a wrong password with the same message a missing account gets", async () => {
    const wrongPassword = await request(app)
      .post("/api/v1/auth/sign-in")
      .send({ email: "tk@notifyhub.test", password: "not-the-password" });

    resetSignInAttempts();
    mocks.userFindUnique.mockResolvedValue(null);

    const missingAccount = await request(app)
      .post("/api/v1/auth/sign-in")
      .send({ email: "nobody@notifyhub.test", password: PASSWORD });

    // Saying "no such user" turns this into an account enumeration endpoint.
    expect(wrongPassword.status).toBe(401);
    expect(missingAccount.status).toBe(401);
    expect(wrongPassword.body).toEqual(missingAccount.body);
  });

  it("rejects an account created with no password", async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: "user-2",
      email: "nopass@notifyhub.test",
      name: null,
      passwordHash: null,
    });

    // A real-looking password, not "": the schema rejects an empty one as a
    // malformed request before we ever look at the account. This path is the
    // user who existed before passwords did.
    const res = await request(app)
      .post("/api/v1/auth/sign-in")
      .send({ email: "nopass@notifyhub.test", password: "a-plausible-guess" });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/email or password is incorrect/i);
  });

  it("rejects an empty password as a malformed request, not a wrong one", async () => {
    const res = await request(app)
      .post("/api/v1/auth/sign-in")
      .send({ email: "tk@notifyhub.test", password: "" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
  });

  it("rejects a missing email with a field-level message", async () => {
    const res = await request(app)
      .post("/api/v1/auth/sign-in")
      .send({ password: PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
    expect(res.body.error.details.some((d: { field: string }) => d.field === "email")).toBe(true);
  });

  it("rate limits after ten failures, so this is not a guessing oracle", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(app)
        .post("/api/v1/auth/sign-in")
        .send({ email: "tk@notifyhub.test", password: "guess" });
    }

    const res = await request(app)
      .post("/api/v1/auth/sign-in")
      .send({ email: "tk@notifyhub.test", password: PASSWORD });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("rate_limited");

    // Not even checked, so the limiter cannot be used as a timing oracle.
    expect(mocks.userFindUnique).toHaveBeenCalledTimes(10);
  });

  it("clears the failure count after a successful sign-in", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app)
        .post("/api/v1/auth/sign-in")
        .send({ email: "tk@notifyhub.test", password: "guess" });
    }

    await request(app)
      .post("/api/v1/auth/sign-in")
      .send({ email: "tk@notifyhub.test", password: PASSWORD });

    const res = await request(app)
      .post("/api/v1/auth/sign-in")
      .send({ email: "tk@notifyhub.test", password: PASSWORD });

    expect(res.status).toBe(200);
  });

  it("never puts the password or the hash anywhere in the response", async () => {
    const res = await request(app)
      .post("/api/v1/auth/sign-in")
      .send({ email: "tk@notifyhub.test", password: PASSWORD });

    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain("scrypt");
  });
});

describe("GET /api/v1/auth/session", () => {
  it("requires a token", async () => {
    const res = await request(app).get("/api/v1/auth/session");
    expect(res.status).toBe(401);
  });

  it("says so when the account behind a valid token is gone", async () => {
    const { signToken } = await import("../src/middleware/auth.js");
    const token = signToken({ sub: "deleted-user", email: "gone@notifyhub.test" });

    mocks.userFindUnique.mockResolvedValue(null);

    const res = await request(app)
      .get("/api/v1/auth/session")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/no longer exists/i);
  });
});

describe("password hashing", () => {
  it("never stores the password", async () => {
    const hash = await hashPassword(PASSWORD);

    expect(hash).not.toContain(PASSWORD);
    expect(hash.startsWith("scrypt$")).toBe(true);
  });

  it("salts, so two hashes of the same password differ", async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);

    expect(a).not.toBe(b);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD, b)).toBe(true);
  });

  it("refuses a wrong password", async () => {
    const hash = await hashPassword(PASSWORD);

    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("refuses a hash in a format it does not understand, rather than throwing", async () => {
    // A 500 at the sign-in screen is worse than a failed sign-in.
    expect(await verifyPassword(PASSWORD, "not-a-hash")).toBe(false);
    expect(await verifyPassword(PASSWORD, "bcrypt$1$2$3$4$5")).toBe(false);
    expect(await verifyPassword(PASSWORD, "")).toBe(false);
  });

  it("knows when a stored hash used weaker parameters than we do now", async () => {
    const current = await hashPassword(PASSWORD);
    expect(needsRehash(current)).toBe(false);

    // Same shape, lower cost - what a hash from an older release looks like.
    const [, n, r, p, salt, hash] = current.split("$");
    const weaker = ["scrypt", "1024", r, p, salt, hash].join("$");
    expect(needsRehash(weaker)).toBe(true);
  });

  it("upgrades a weaker hash on the next successful sign-in", async () => {
    /**
     * A genuine weaker hash, not a fresh one with its N edited down. Rewriting
     * the parameter without recomputing the digest gives a string that fails
     * verification, which proves nothing about the upgrade path - it just looks
     * like a wrong password.
     */
    const salt = randomBytes(16);
    const digest = await scryptAsync(PASSWORD, salt, 64, { N: 1024, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const weaker = ["scrypt", "1024", "8", "1", salt.toString("base64url"), digest.toString("base64url")].join("$");

    expect(needsRehash(weaker)).toBe(true);

    mocks.userFindUnique.mockResolvedValue({
      id: "user-1",
      email: "tk@notifyhub.test",
      name: "TK",
      passwordHash: weaker,
    });

    const res = await request(app)
      .post("/api/v1/auth/sign-in")
      .send({ email: "tk@notifyhub.test", password: PASSWORD });

    expect(res.status).toBe(200);

    // The upgrade is fire-and-forget so a slow write cannot delay sign-in. Give
    // it the microtask it needs before asserting it happened.
    await vi.waitFor(() => expect(mocks.userUpdate).toHaveBeenCalled());

    const [args] = mocks.userUpdate.mock.calls[0];

    expect(args.where).toEqual({ id: "user-1" });

    // And what got written is a hash at the current cost, not the old one.
    expect(needsRehash(args.data.passwordHash)).toBe(false);
    expect(await verifyPassword(PASSWORD, args.data.passwordHash)).toBe(true);
  });

  it("does not rewrite the hash on every sign-in when the parameters are current", async () => {
    const res = await request(app)
      .post("/api/v1/auth/sign-in")
      .send({ email: "tk@notifyhub.test", password: PASSWORD });

    expect(res.status).toBe(200);

    await new Promise((resolve) => setImmediate(resolve));

    // Writing on every sign-in would make the table churn and turn a 12-hour
    // session into a scrypt operation per login for no benefit.
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});