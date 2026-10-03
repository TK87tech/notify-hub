/**
 * The token store.
 *
 * localStorage rather than a cookie, because the API authenticates with a bearer
 * token and the contract has no cookie flow. The tradeoff is accepted knowingly:
 * a token in localStorage is readable by any script that gets injected into the
 * page, so this is only safe while there is no XSS. It is a portfolio project on
 * a free tier, not a bank, and the alternative - moving to httpOnly cookies -
 * would mean changing the contract's auth scheme for every client at once.
 *
 * What this file does *not* do is trust the token's contents. Nothing here
 * decodes it to decide whether the user is signed in; that is the server's call,
 * via GET /auth/session. A tampered token in localStorage gets the user a 401
 * and a redirect to sign-in, which is the correct outcome.
 */

const TOKEN_KEY = "notifyhub.token";

/** Not every environment has localStorage - private mode and SSR both can refuse. */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readToken(): string | null {
  return storage()?.getItem(TOKEN_KEY) ?? null;
}

export function writeToken(token: string): void {
  storage()?.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  storage()?.removeItem(TOKEN_KEY);
}

/**
 * Whether the token is past its expiry, read from the payload.
 *
 * This is a convenience to avoid a pointless round trip and a flash of signed-out
 * UI on reload. It is explicitly not trusted: `exp` is only as good as the
 * signature, and an attacker who could set a token could set `exp` too. The real
 * check is the 401 from the API.
 */
export function isTokenExpired(token: string, now = Date.now()): boolean {
  const [, payload] = token.split(".");

  if (!payload) return true;

  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      exp?: number;
    };

    if (typeof claims.exp !== "number") return false;

    // A small margin, so a token that expires in 200ms is not treated as valid
    // for a request that will land after it lapses.
    return claims.exp * 1000 <= now + 10_000;
  } catch {
    // Unparseable means not usable. Treat as expired so the app asks for a
    // fresh sign-in rather than sending garbage to the API.
    return true;
  }
}

export function hasUsableToken(now = Date.now()): boolean {
  const token = readToken();

  return token !== null && !isTokenExpired(token, now);
}