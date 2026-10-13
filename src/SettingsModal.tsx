import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ACCENTS, DEFAULT_SETTINGS, type Settings } from "./lib/settings";
import { pickFile } from "./lib/fs";
import { CookiesPanel } from "./CookiesPanel";
import { KVEditor } from "./KVEditor";
import { emptyKV } from "./lib/util";

export type SettingsSection = "general" | "appearance" | "variables" | "network" | "cookies" | "shortcuts" | "data" | "about";

const NAV: { id: SettingsSection; label: string; icon: string }[] = [
  { id: "general", label: "Requests", icon: "⇄" },
  { id: "appearance", label: "Appearance", icon: "◐" },
  { id: "variables", label: "Variables", icon: "{ }" },
  { id: "network", label: "Network", icon: "☍" },
  { id: "cookies", label: "Cookies", icon: "◍" },
  { id: "shortcuts", label: "Shortcuts", icon: "⌘" },
  { id: "data", label: "Data", icon: "▤" },
  { id: "about", label: "About", icon: "ⓘ" },
];

export const SHORTCUTS: [string, string][] = [
  ["Send request", "⌘ ↵"],
  ["New request", "⌘ T"],
  ["Save request", "⌘ S"],
  ["Close tab", "⌘ W"],
  ["Command palette", "⌘ K"],
  ["Focus URL bar", "⌘ L"],
  ["Duplicate tab", "⌘ D"],
  ["Generate code", "⇧ ⌘ G"],
  ["Next / previous tab", "⌃ ⇥  /  ⌃ ⇧ ⇥"],
  ["Open collection", "⌘ O"],
  ["New collection", "⇧ ⌘ N"],
  ["Import", "⇧ ⌘ I"],
  ["Toggle sidebar", "⌘ B"],
  ["Zoom in / out / reset", "⌘ =  /  ⌘ -  /  ⌘ 0"],
  ["Settings", "⌘ ,"],
  ["Keyboard shortcuts", "⌘ /"],
];

type Props = {
  settings: Settings;
  onChange: (p: Partial<Settings>) => void;
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  onClose: () => void;
  onClearHistory: () => void;
  onResetState: () => void;
  onClearSession: () => void;
};

export function SettingsModal({ settings: s, onChange, section, onSection, onClose, onClearHistory, onResetState, onClearSession }: Props) {
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("dev"));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const row = (label: string, hint: string | undefined, control: React.ReactNode) => (
    <div className="set-row">
      <div className="set-label">
        <b>{label}</b>
        {hint && <span>{hint}</span>}
      </div>
      <div className="set-control">{control}</div>
    </div>
  );
  const toggle = (k: keyof Settings) => (
    <label className="switch">
      <input type="checkbox" checked={Boolean(s[k])} onChange={(e) => onChange({ [k]: e.target.checked } as Partial<Settings>)} />
      <span />
    </label>
  );
  const pathField = (k: "caCert" | "clientCert" | "clientKey", ph: string, ext: string[]) => (
    <div className="path-field">
      <input className="cell" placeholder={ph} value={s[k]} spellCheck={false} onChange={(e) => onChange({ [k]: e.target.value } as Partial<Settings>)} />
      <button className="btn small" onClick={async () => { const f = await pickFile("Choose a file", ext); if (f) onChange({ [k]: f } as Partial<Settings>); }}>Choose…</button>
      {s[k] && <button className="btn small" onClick={() => onChange({ [k]: "" } as Partial<Settings>)}>Clear</button>}
    </div>
  );

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="settings" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <nav className="settings-nav">
          <h3>Settings</h3>
          {NAV.map((n) => (
            <button key={n.id} className={section === n.id ? "on" : ""} onClick={() => onSection(n.id)}>
              <span className="nav-ic">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <button className="icon-btn settings-x" onClick={onClose} aria-label="Close settings">×</button>

          {section === "general" && (
            <>
              <h2>Requests</h2>
              {row("Timeout", "New requests start with this timeout (ms).", <input className="cell narrow" type="number" min={100} value={s.timeoutMs} onChange={(e) => onChange({ timeoutMs: Math.max(100, Number(e.target.value) || 30000) })} />)}
              {row("Follow redirects", "Default for new requests.", toggle("followRedirects"))}
              {row("Verify TLS certificates", "Turn off only for local development with self-signed certificates. Applies to new requests; each request can still override it.", toggle("verifyTls"))}
              {row("Auto-save requests", "Write changes to the request file automatically a moment after you stop typing. Only requests saved in a collection.", toggle("autoSave"))}
              {row("History size", "How many sent requests to remember.", (
                <select value={s.historyLimit} onChange={(e) => onChange({ historyLimit: Number(e.target.value) })}>
                  {[25, 50, 100, 250, 500].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              ))}
              {row("Confirm before deleting", "Ask before deleting requests, folders and environments.", toggle("confirmDelete"))}
            </>
          )}

          {section === "appearance" && (
            <>
              <h2>Appearance</h2>
              {row("Theme", undefined, (
                <div className="seg wide">
                  {(["system", "light", "dark"] as const).map((t) => (
                    <button key={t} className={s.theme === t ? "on" : ""} onClick={() => onChange({ theme: t })}>{t[0].toUpperCase() + t.slice(1)}</button>
                  ))}
                </div>
              ))}
              {row("Accent colour", undefined, (
                <div className="swatches">
                  {ACCENTS.map((a) => (
                    <button key={a.name} title={a.name} className={s.accent === a.name ? "on" : ""} style={{ background: a.light }} onClick={() => onChange({ accent: a.name })} aria-label={a.name} />
                  ))}
                </div>
              ))}
              {row("Zoom", "Also ⌘ = / ⌘ - / ⌘ 0.", (
                <div className="row">
                  <input type="range" min={0.8} max={1.5} step={0.05} value={s.zoom} onChange={(e) => onChange({ zoom: Number(e.target.value) })} />
                  <span className="muted">{Math.round(s.zoom * 100)}%</span>
                </div>
              ))}
            </>
          )}

          {section === "variables" && (
            <>
              <h2>Global variables</h2>
              <p className="muted small">Available in every collection, kept on this Mac and never written into a collection. They are the lowest level: collection and folder variables, then the environment, then values set by scripts all override them. The CLI doesn't see these: pass <code>--var name=value</code> there.</p>
              <KVEditor rows={s.globals.length ? s.globals : [emptyKV()]} onChange={(globals) => onChange({ globals })} keyPlaceholder="Variable" />
            </>
          )}

          {section === "network" && (
            <>
              <h2>Network</h2>
              <p className="muted small">Applies to every request, OAuth token call and spec download.</p>
              {row("Proxy", undefined, (
                <select value={s.proxyMode} onChange={(e) => onChange({ proxyMode: e.target.value as Settings["proxyMode"] })}>
                  <option value="env">System (HTTP_PROXY / HTTPS_PROXY)</option>
                  <option value="none">No proxy</option>
                  <option value="custom">Custom</option>
                </select>
              ))}
              {s.proxyMode === "custom" && (
                <>
                  {row("Proxy URL", "http://, https:// or socks5://", <input className="cell" placeholder="http://127.0.0.1:8080" value={s.proxyUrl} spellCheck={false} onChange={(e) => onChange({ proxyUrl: e.target.value })} />)}
                  {row("Bypass proxy for", "Comma-separated hosts.", <input className="cell" placeholder="localhost, 127.0.0.1, .internal.example.com" value={s.noProxy} spellCheck={false} onChange={(e) => onChange({ noProxy: e.target.value })} />)}
                </>
              )}
              {row("CA certificate", "PEM file with extra trusted roots, e.g. a corporate CA.", pathField("caCert", "Not set", ["pem", "crt", "cer"]))}
              {row("Client certificate", "For mutual TLS. PEM certificate (and key, below).", pathField("clientCert", "Not set", ["pem", "crt", "cer"]))}
              {row("Client key", "PEM private key, if separate from the certificate.", pathField("clientKey", "Not set", ["pem", "key"]))}
              {row("User agent", "Leave empty for the default.", <input className="cell" placeholder="Reqnest/0.1.0" value={s.userAgent} spellCheck={false} onChange={(e) => onChange({ userAgent: e.target.value })} />)}
            </>
          )}

          {section === "cookies" && (
            <>
              <h2>Cookies</h2>
              {row("Store and send cookies", "Like a browser: cookies from responses are saved and sent with later requests to the same site. Kept on this Mac.", toggle("cookies"))}
              <CookiesPanel />
            </>
          )}

          {section === "shortcuts" && (
            <>
              <h2>Keyboard shortcuts</h2>
              <div className="shortcuts">
                {SHORTCUTS.map(([a, k]) => (
                  <div key={a} className="sc-row"><span>{a}</span><kbd>{k}</kbd></div>
                ))}
              </div>
            </>
          )}

          {section === "data" && (
            <>
              <h2>Data</h2>
              <p className="muted small">Collections live in your own folders as plain files. Nothing here touches them.</p>
              {row("Request history", "Remembered sent requests.", <button className="btn small" onClick={onClearHistory}>Clear history</button>)}
              {row("Session variables & tokens", "Values set by scripts, captures and OAuth. Kept in memory only.", <button className="btn small" onClick={onClearSession}>Clear</button>)}
              {row("Restore default settings", undefined, <button className="btn small" onClick={() => onChange({ ...DEFAULT_SETTINGS })}>Restore defaults</button>)}
              {row("Reset app state", "Forgets open tabs, history, the last collection and all settings, then reloads.", <button className="btn small danger-text" onClick={onResetState}>Reset…</button>)}
            </>
          )}

          {section === "about" && (
            <div className="about">
              <div className="about-logo">◆</div>
              <h2>Reqnest</h2>
              <p className="muted">Version {version}</p>
              <p>Local-first API client. No account, no cloud, no telemetry.</p>
              <div className="row center-row">
                <button className="btn small" onClick={() => openUrl("https://github.com/batuhanilgarr/Reqnest")}>GitHub</button>
                <button className="btn small" onClick={() => openUrl("https://github.com/batuhanilgarr/Reqnest/issues/new")}>Report an issue</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
