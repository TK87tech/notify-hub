/**
 * Password hashing, on node:crypto's scrypt.
 *
 * No dependency, because scrypt is already here and is a deliberately slow,
 * memory-hard KDF - which is exactly what a password hash should be. bcrypt and
 * argon2 are also fine choices; this avoids adding a native module that has to
 * be rebuilt on every platform we deploy to, for no practical gain here.
 *
 * The stored format is `scrypt$N$r$p$salt$hash`, all base64url. Encoding the
 * parameters in the string is what lets the cost be raised later without
 * invalidating existing passwords: old hashes keep verifying with their own
 * parameters, and `needsRehash` says when to upgrade one.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Current cost parameters. Node's default maxmem is too low for N=16384. */
const PARAMS = { N: 16_384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MAXMEM = 64 * 1024 * 1024;

const ALGORITHM = "scrypt";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAXMEM });

  return [
    ALGORITHM,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");

  if (parts.length !== 6 || parts[0] !== ALGORITHM) {
    return false;
  }

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);

  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  let expected: Buffer;
  let actual: Buffer;

  try {
    const salt = Buffer.from(saltRaw, "base64url");
    expected = Buffer.from(hashRaw, "base64url");
    actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: MAXMEM });
  } catch {
    // A hash stored by some future or foreign format. Refuse rather than throw
    // a 500 at somebody trying to sign in.
    return false;
  }

  if (expected.length !== actual.length) return false;

  return timingSafeEqual(expected, actual);
}

/** True when a stored hash was made with weaker parameters than we use now. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");

  if (parts.length !== 6 || parts[0] !== ALGORITHM) return true;

  const [, nRaw, rRaw, pRaw] = parts;

  return Number(nRaw) < PARAMS.N || Number(rRaw) < PARAMS.r || Number(pRaw) < PARAMS.p;
}