import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { OAuthConfig, ResponseData } from "./types";

export type TokenInfo = {
  accessToken: string;
  tokenType: string;
  /** epoch ms, or null when the server didn't say */
  expiresAt: number | null;
  refreshToken?: string;
  scope?: string;
};

export type TokenCache = Map<string, TokenInfo>;

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const randomString = (bytes = 48) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function pkcePair() {
  const verifier = randomString(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

/** Cache key: same endpoint + client + scope + user share a token; changing any of them gets a fresh one. */
export const tokenKey = (c: OAuthConfig) => JSON.stringify([c.grant, c.tokenUrl, c.clientId, c.scope, c.username]);

const valid = (t: TokenInfo | undefined) => !!t && (t.expiresAt === null || t.expiresAt - 30_000 > Date.now());

async function tokenRequest(c: OAuthConfig, params: Record<string, string>): Promise<TokenInfo> {
  if (!c.tokenUrl) throw new Error("OAuth2: token URL is empty");
  const body = new URLSearchParams(params);
  const headers: [string, string][] = [
    ["Content-Type", "application/x-www-form-urlencoded"],
    ["Accept", "application/json"],
  ];
  if (c.clientAuth === "basic" && c.clientId) {
    headers.push(["Authorization", `Basic ${btoa(unescape(encodeURIComponent(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`)))}`]);
  } else {
    if (c.clientId) body.set("client_id", c.clientId);
    if (c.clientSecret) body.set("client_secret", c.clientSecret);
  }
  for (const e of c.extra) if (e.enabled && e.key) body.set(e.key, e.value);

  const res = await invoke<ResponseData>("send_request", {
    spec: { method: "POST", url: c.tokenUrl, headers, body: body.toString(), timeoutMs: 30000, insecure: false, followRedirects: true },
  });
  let json: any;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* handled below */
  }
  if (res.status >= 400 || !json?.access_token) {
    const why = json?.error_description || json?.error || res.body.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`OAuth2 token request failed (${res.status}): ${why}`);
  }
  const ttl = Number(json.expires_in);
  return {
    accessToken: String(json.access_token),
    tokenType: String(json.token_type ?? "Bearer"),
    expiresAt: Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl * 1000 : null,
    refreshToken: json.refresh_token ? String(json.refresh_token) : undefined,
    scope: json.scope ? String(json.scope) : undefined,
  };
}

async function authorizationCodeFlow(c: OAuthConfig): Promise<TokenInfo> {
  if (!c.authUrl) throw new Error("OAuth2: authorization URL is empty");
  const redirectUri = `http://127.0.0.1:${c.redirectPort}/callback`;
  const state = randomString(16);
  const url = new URL(c.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", c.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  if (c.scope) url.searchParams.set("scope", c.scope);
  url.searchParams.set("state", state);
  let verifier = "";
  if (c.pkce) {
    const p = await pkcePair();
    verifier = p.verifier;
    url.searchParams.set("code_challenge", p.challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const e of c.extra) if (e.enabled && ["audience", "resource"].includes(e.key)) url.searchParams.set(e.key, e.value);

  // Listen first, then open the browser, so the redirect can never beat the listener.
  const waiting = invoke<string>("oauth_listen", { port: c.redirectPort, timeoutSecs: 180 });
  waiting.catch(() => {});
  await new Promise((r) => setTimeout(r, 80));
  await openUrl(url.toString());
  const query = new URLSearchParams(await waiting);
  if (query.get("error")) throw new Error(`OAuth2 sign-in failed: ${query.get("error_description") || query.get("error")}`);
  if (query.get("state") !== state) throw new Error("OAuth2: state mismatch, ignoring the response");
  const code = query.get("code");
  if (!code) throw new Error("OAuth2: no authorization code in the redirect");
  return tokenRequest(c, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    ...(verifier ? { code_verifier: verifier } : {}),
  });
}

/**
 * Return a usable access token: cached if still valid, silently refreshed if possible, otherwise
 * fetched (opening the system browser for the authorization-code grant).
 */
export async function getToken(c: OAuthConfig, cache: TokenCache, opts: { force?: boolean } = {}): Promise<TokenInfo> {
  const key = tokenKey(c);
  const cached = cache.get(key);
  if (!opts.force && valid(cached)) return cached!;

  let token: TokenInfo | undefined;
  if (cached?.refreshToken) {
    try {
      token = await tokenRequest(c, { grant_type: "refresh_token", refresh_token: cached.refreshToken });
      token.refreshToken ??= cached.refreshToken; // servers may omit it on refresh
    } catch {
      /* refresh token expired or revoked: fall through to a full flow */
    }
  }
  if (!token) {
    if (c.grant === "client_credentials")
      token = await tokenRequest(c, { grant_type: "client_credentials", ...(c.scope ? { scope: c.scope } : {}) });
    else if (c.grant === "password")
      token = await tokenRequest(c, { grant_type: "password", username: c.username, password: c.password, ...(c.scope ? { scope: c.scope } : {}) });
    else token = await authorizationCodeFlow(c);
  }
  cache.set(key, token);
  return token;
}
