import { useState } from "react";
import type { AuthMode, OAuthConfig, OAuthGrant, RequestTab } from "./lib/types";
import type { TokenInfo } from "./lib/oauth";
import { KVEditor } from "./KVEditor";

type Props = {
  tab: RequestTab;
  patch: (p: Partial<RequestTab>) => void;
  token: TokenInfo | undefined;
  busy: boolean;
  onGetToken: () => void;
  onResetToken: () => void;
  /** undefined: no inheritance here (folder defaults editor). null/string: offer "inherit"; the string says where from. */
  inheritFrom: string | null | undefined;
  showToken?: boolean;
};

const ttl = (t: TokenInfo) => {
  if (t.expiresAt === null) return "no expiry reported";
  const s = Math.round((t.expiresAt - Date.now()) / 1000);
  if (s <= 0) return t.refreshToken ? "expired, will refresh automatically" : "expired";
  return s > 3600 ? `valid for ${Math.round(s / 360) / 10} h` : s > 90 ? `valid for ${Math.round(s / 60)} min` : `valid for ${s}s`;
};

export function AuthPanel({ tab, patch, token, busy, onGetToken, onResetToken, inheritFrom, showToken = true }: Props) {
  const [reveal, setReveal] = useState(false);
  const o = tab.oauth;
  const set = (p: Partial<OAuthConfig>) => patch({ oauth: { ...o, ...p } });
  const text = (label: string, key: keyof OAuthConfig, ph = "", type = "text") => (
    <label className="field">
      <span>{label}</span>
      <input className="cell" type={type} placeholder={ph} spellCheck={false} value={String(o[key] ?? "")} onChange={(e) => set({ [key]: e.target.value } as Partial<OAuthConfig>)} />
    </label>
  );

  return (
    <div className="col wide auth">
      <select aria-label="Authorization type" value={tab.authMode} onChange={(e) => patch({ authMode: e.target.value as AuthMode })}>
        {inheritFrom !== undefined && <option value="inherit">Inherit from folder / collection</option>}
        <option value="none">No auth</option>
        <option value="bearer">Bearer token</option>
        <option value="basic">Basic auth</option>
        <option value="oauth2">OAuth 2.0</option>
      </select>
      {tab.authMode === "inherit" && (
        <p className="muted small">
          {inheritFrom ? `Using the auth set on “${inheritFrom}”.` : "No parent folder or the collection sets auth yet. Set it with ⚙ on the folder or collection."}
        </p>
      )}
      {tab.authMode === "bearer" && <input className="cell" placeholder="Token" value={tab.authToken} onChange={(e) => patch({ authToken: e.target.value })} />}
      {tab.authMode === "basic" && (
        <>
          <input className="cell" placeholder="Username" value={tab.authUser} onChange={(e) => patch({ authUser: e.target.value })} />
          <input className="cell" type="password" placeholder="Password" value={tab.authPass} onChange={(e) => patch({ authPass: e.target.value })} />
        </>
      )}
      {tab.authMode === "oauth2" && (
        <>
          <label className="field">
            <span>Grant type</span>
            <select aria-label="Grant type" value={o.grant} onChange={(e) => set({ grant: e.target.value as OAuthGrant })}>
              <option value="client_credentials">Client credentials</option>
              <option value="authorization_code">Authorization code (browser sign-in)</option>
              <option value="password">Password (legacy)</option>
            </select>
          </label>
          {o.grant === "authorization_code" && text("Authorization URL", "authUrl", "https://auth.example.com/authorize")}
          {text("Token URL", "tokenUrl", "https://auth.example.com/oauth/token")}
          {text("Client ID", "clientId", "{{clientId}}")}
          {text("Client secret", "clientSecret", "{{clientSecret}} (optional for public clients)", "password")}
          {text("Scope", "scope", "read write")}
          {o.grant === "password" && (
            <>
              {text("Username", "username")}
              {text("Password", "password", "", "password")}
            </>
          )}
          {o.grant === "authorization_code" && (
            <div className="row">
              <label className="check">
                <input type="checkbox" checked={o.pkce} onChange={(e) => set({ pkce: e.target.checked })} /> Use PKCE
              </label>
              <label className="check">
                Redirect port
                <input className="cell narrow" aria-label="Redirect port" type="number" value={o.redirectPort} onChange={(e) => set({ redirectPort: Number(e.target.value) || 8976 })} />
              </label>
            </div>
          )}
          {o.grant === "authorization_code" && (
            <p className="muted small">
              Register <code>http://127.0.0.1:{o.redirectPort}/callback</code> as a redirect URI. Sign-in opens in your default browser.
            </p>
          )}
          <label className="field">
            <span>Send client credentials</span>
            <select aria-label="Client authentication" value={o.clientAuth} onChange={(e) => set({ clientAuth: e.target.value as "basic" | "body" })}>
              <option value="basic">As Basic auth header</option>
              <option value="body">In the request body</option>
            </select>
          </label>
          {text("Header prefix", "prefix", "Bearer")}
          <div>
            <p className="muted small">Extra token request fields (audience, resource, …)</p>
            <KVEditor rows={o.extra} onChange={(extra) => set({ extra })} />
          </div>
          {showToken && <div className="token-box">
            {token ? (
              <>
                <div className="row">
                  <b className="ok-text">● Token</b>
                  <span className="muted">{ttl(token)}</span>
                  {token.scope && <span className="muted">· {token.scope}</span>}
                </div>
                <code className="token">{reveal ? token.accessToken : token.accessToken.slice(0, 6) + "•••••••••••"}</code>
              </>
            ) : (
              <span className="muted">No token yet. It's fetched automatically on Send, or get it now.</span>
            )}
            <div className="row">
              <button className="btn small" onClick={onGetToken} disabled={busy}>
                {busy ? "Waiting…" : token ? "Get new token" : "Get token"}
              </button>
              {token && (
                <>
                  <button className="btn small" onClick={() => setReveal(!reveal)}>{reveal ? "Hide" : "Show"}</button>
                  <button className="btn small" onClick={() => navigator.clipboard.writeText(token.accessToken)}>Copy</button>
                  <button className="btn small" onClick={onResetToken}>Reset</button>
                </>
              )}
            </div>
          </div>}
        </>
      )}
    </div>
  );
}
