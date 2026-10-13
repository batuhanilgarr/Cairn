import type { KV } from "./types";
import { DEFAULT_AI, type AiConfig } from "./ai";
import { load, save } from "./util";

export type Settings = {
  theme: "system" | "light" | "dark";
  accent: string;
  zoom: number;
  // requests
  timeoutMs: number;
  followRedirects: boolean;
  verifyTls: boolean;
  autoSave: boolean;
  historyLimit: number;
  confirmDelete: boolean;
  // network
  proxyMode: "env" | "none" | "custom";
  proxyUrl: string;
  noProxy: string;
  caCert: string;
  clientCert: string;
  clientKey: string;
  userAgent: string;
  cookies: boolean;
  /** Global variables: the lowest level, available in every collection. Kept on this Mac, not in Git. */
  globals: KV[];
  /** AI assistant endpoint. Kept on this Mac only. */
  ai: AiConfig;
};

export const ACCENTS: { name: string; light: string; dark: string }[] = [
  { name: "Violet", light: "#6c4cf5", dark: "#8b74ff" },
  { name: "Blue", light: "#2563eb", dark: "#60a5fa" },
  { name: "Teal", light: "#0d9488", dark: "#2dd4bf" },
  { name: "Green", light: "#16a34a", dark: "#4ade80" },
  { name: "Orange", light: "#ea580c", dark: "#fb923c" },
  { name: "Pink", light: "#db2777", dark: "#f472b6" },
];

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  accent: "Violet",
  zoom: 1,
  timeoutMs: 30000,
  followRedirects: true,
  verifyTls: true,
  autoSave: false,
  historyLimit: 100,
  confirmDelete: true,
  proxyMode: "env",
  proxyUrl: "",
  noProxy: "",
  caCert: "",
  clientCert: "",
  clientKey: "",
  userAgent: "",
  cookies: true,
  globals: [],
  ai: DEFAULT_AI,
};

export const loadSettings = (): Settings => {
  const saved = load<Partial<Settings>>("rq.settings", {});
  return { ...DEFAULT_SETTINGS, ...saved, ai: { ...DEFAULT_AI, ...(saved.ai ?? {}) } };
};
export const saveSettings = (s: Settings) => save("rq.settings", s);

/** Theme + accent are applied through CSS variables on <html>, so every component follows without props. */
export function applyAppearance(s: Settings) {
  const root = document.documentElement;
  if (s.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = s.theme;
  const a = ACCENTS.find((x) => x.name === s.accent) ?? ACCENTS[0];
  root.style.setProperty("--accent-light", a.light);
  root.style.setProperty("--accent-dark", a.dark);
}

export const networkOf = (s: Settings) => ({
  proxyMode: s.proxyMode,
  proxyUrl: s.proxyUrl,
  noProxy: s.noProxy,
  caCert: s.caCert,
  clientCert: s.clientCert,
  clientKey: s.clientKey,
  userAgent: s.userAgent,
  cookiesDisabled: !s.cookies,
});
