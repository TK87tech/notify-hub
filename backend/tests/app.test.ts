/**
 * Tests for the app shell and the two auth middlewares.
 *
 * These run without a database or a server - supertest drives the Express
 * app in memory. The only test that needs Postgres is the readiness one,
 * which is why it is not here.
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import type { Express } from "express";

let app: Express;
let signToken: (p: { sub: string; email: string }, e?: string) => string;

const SECRET = "test-secret-at-least-16-chars";
const SERVICE_KEY = "test-service-key";

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = SECRET;
  process.env.SERVICE_KEY = SERVICE_KEY;
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";

  // Imported after the env is set, because config/env.ts validates on import.
  const appModule = await import("../src/app.js");
  const authModule = await import("../src/middleware/auth.js");
  app = appModule.createApp();
  signToken = authModule.signToken;
});

describe("GET /health", () => {
  it("returns 200 without any authentication", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptime).toBe("number");
  });
});

describe("browser routes (JWT)", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await request(app).get("/api/v1/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("rejects a malformed Authorization header", async () => {
    const res = await request(app).get("/api/v1/me").set("Authorization", "NotBearer abc");
    expect(res.status).toBe(401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = jwt.sign({ sub: "u1", email: "a@b.c" }, "the-wrong-secret-entirely");
    const res = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/not valid/i);
  });

  it("rejects an expired token, and says so", async () => {
    const expired = jwt.sign({ sub: "u1", email: "a@b.c" }, SECRET, { expiresIn: "-1s" });
    const res = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/expired/i);
  });

  it("accepts a valid token and exposes the user", async () => {
    const token = signToken({ sub: "user-123", email: "tk@notifyhub.test" });
    const res = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "user-123", email: "tk@notifyhub.test" });
  });
});

describe("service routes (x-service-key)", () => {
  it("rejects a request with no key", async () => {
    const res = await request(app).get("/internal/ping");
    expect(res.status).toBe(401);
  });

  it("rejects a wrong key with 403, not 401", async () => {
    const res = await request(app).get("/internal/ping").set("x-service-key", "nope-not-it-x");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("accepts the right key", async () => {
    const res = await request(app).get("/internal/ping").set("x-service-key", SERVICE_KEY);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("service");
  });

  it("does not accept a user JWT on a service route", async () => {
    const token = signToken({ sub: "user-123", email: "tk@notifyhub.test" });
    const res = await request(app).get("/internal/ping").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe("errors", () => {
  it("returns the contract's Error shape for an unknown route", async () => {
    const res = await request(app).get("/no/such/route");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error.code", "not_found");
    expect(res.body).toHaveProperty("error.message");
  });

  it("returns 400 for a malformed JSON body", async () => {
    const res = await request(app)
      .post("/internal/ping")
      .set("x-service-key", SERVICE_KEY)
      .set("Content-Type", "application/json")
      .send("{ this is not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("never leaks a stack trace in the response", async () => {
    const res = await request(app).get("/no/such/route");
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts:/);
  });
});
