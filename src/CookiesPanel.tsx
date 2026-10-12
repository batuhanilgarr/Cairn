import { useCallback, useEffect, useMemo, useState } from "react";
import { addCookie, clearCookies, deleteCookie, listCookies, type Cookie } from "./lib/cookies";

export function CookiesPanel() {
  const [cookies, setCookies] = useState<Cookie[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ domain: "", path: "/", name: "", value: "" });

  const refresh = useCallback(() => listCookies().then(setCookies).catch((e) => setError(String(e))), []);
  useEffect(() => void refresh(), [refresh]);

  const byDomain = useMemo(() => {
    const m = new Map<string, Cookie[]>();
    for (const c of cookies) m.set(c.domain, [...(m.get(c.domain) ?? []), c]);
    return [...m.entries()];
  }, [cookies]);

  const run = (p: Promise<unknown>) => p.then(() => { setError(null); return refresh(); }).catch((e) => setError(String(e)));

  return (
    <div className="cookies">
      {error && <p className="err small">{error}</p>}
      {byDomain.length === 0 && <p className="muted">No cookies stored yet. They appear here when a server sends Set-Cookie.</p>}
      {byDomain.map(([domain, list]) => (
        <div key={domain} className="cookie-group">
          <div className="cookie-domain">
            <b>{domain}</b>
            <button className="link" onClick={() => run(clearCookies(domain))}>Clear</button>
          </div>
          {list.map((c) => (
            <div key={`${c.path}|${c.name}`} className="cookie-row">
              <code className="cookie-name">{c.name}</code>
              <span className="cookie-value" title={c.value}>{c.value}</span>
              <span className="cookie-meta">
                {c.path}
                {c.secure ? " · Secure" : ""}
                {c.httpOnly ? " · HttpOnly" : ""}
                {` · ${c.expires ? `expires ${new Date(c.expires).toLocaleString()}` : "session"}`}
              </span>
              <button className="icon-btn" onClick={() => run(deleteCookie(c))} aria-label={`Delete ${c.name}`}>×</button>
            </div>
          ))}
        </div>
      ))}
      <div className="cookie-add">
        <b>Add a cookie</b>
        <div className="row">
          <input className="cell" placeholder="domain (api.example.com)" value={draft.domain} onChange={(e) => setDraft({ ...draft, domain: e.target.value })} />
          <input className="cell narrow" placeholder="/" value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value })} />
        </div>
        <div className="row">
          <input className="cell" placeholder="name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className="cell" placeholder="value" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
          <button className="btn small" disabled={!draft.domain || !draft.name} onClick={() => run(addCookie(draft).then(() => setDraft({ ...draft, name: "", value: "" })))}>Add</button>
        </div>
      </div>
      {byDomain.length > 0 && <button className="btn small danger-text" onClick={() => run(clearCookies())}>Clear all cookies</button>}
    </div>
  );
}
