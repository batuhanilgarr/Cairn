import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sendRaw } from "./lib/net";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SettingsModal, type SettingsSection } from "./SettingsModal";
import { CommandPalette, type Command } from "./CommandPalette";
import { applyAppearance, loadSettings, networkOf, saveSettings, type Settings } from "./lib/settings";
import { setNetwork } from "./lib/net";
import { KVEditor } from "./KVEditor";
import { CodeEditor, type Lang, type VarMap } from "./CodeEditor";
import type { EditorView } from "@codemirror/view";
import { Dialog, type DialogState } from "./Dialog";
import { Tree } from "./Tree";
import { AuthPanel } from "./AuthPanel";
import { ScriptsPanel } from "./ScriptsPanel";
import { TestsPanel } from "./TestsPanel";
import { RunnerModal, type RunState } from "./RunnerModal";
import { DefaultsModal } from "./DefaultsModal";
import { GraphQLPanel } from "./GraphQLPanel";
import { StreamLog } from "./StreamLog";
import { CodeGenModal } from "./CodeGenModal";
import { DiffModal, type HistEntry } from "./DiffModal";
import { ExamplesPanel } from "./ExamplesPanel";
import { MockModal } from "./MockModal";
import { Welcome } from "./Welcome";
import { Logo } from "./Logo";
import { buildRoutes, mockStart, mockStop, type MockHit } from "./lib/mock";
import { BinaryView, suggestFileName } from "./BinaryView";
import { parseSetCookie } from "./lib/cookies";
import { GrpcPanel, type GrpcSchema } from "./GrpcPanel";
import { McpPanel } from "./McpPanel";
import { loadInfo, mcpClose, mcpConnect, mcpRequest, rpcLabel, splitArgs, type McpInfo } from "./lib/mcp";
import { WsPanel, type WsMode } from "./WsPanel";
import { EMPTY_STREAM, MAX_ENTRIES, grpcCall, grpcDescribe, grpcEnd, grpcSend, sseConnect, streamStop, subscribe, unsubscribe, wsClose, wsConnect, wsSend, type StreamEntry, type StreamEvent, type StreamState } from "./lib/stream";
import { cachedSchema, loadGraphQL, storeSchema } from "./lib/graphql";
import { applyDefaults, type Layer } from "./lib/inherit";
import { executeRequest, prepareRequest, resolveOAuth, withSession } from "./lib/pipeline";
import { buildRequest } from "./lib/util";
import { DYNAMIC_DESCRIPTIONS } from "./lib/dynamic";
import { MultipartEditor } from "./MultipartEditor";
import { getToken, tokenKey, type TokenCache } from "./lib/oauth";
import {
  basename,
  dirname,
  listFilesRecursive,
  listTree,
  makeDir,
  pickAnyFile,
  pickFile,
  pickFolder,
  saveResponse,
  readText,
  removePath,
  renamePath,
  writeText,
} from "./lib/fs";
import {
  initCollection,
  loadChain,
  loadDefaults,
  saveDefaults,
  type ChainLink,
  loadEnvironments,
  readCollectionMeta,
  writeCollectionMeta,
  parseRequest,
  readCollectionName,
  requestPath,
  saveEnvironment,
  serializeRequest,
  slug,
  uniquePath,
} from "./lib/collection";
import type { BodyMode, Collection, RequestKind, Environment, HistoryItem, RequestTab, ResponseData, RunOutput, TreeNode } from "./lib/types";
import {
  METHODS,
  emptyKV,
  formatBytes,
  interpolate,
  load,
  newTab,
  normalizeTab,
  save,
  setTabDefaults,
  statusClass,
  tryPrettyJson,
  uid,
} from "./lib/util";
import { looksLikeCurl, parseCurl } from "./lib/curl";
import { parseOpenApi, type ImportedRequest } from "./lib/openapi";
import { parsePostman } from "./lib/postman";
import { parseBru, parseBruEnv } from "./lib/bruno";
import { ensureEnvironment, writeImport } from "./lib/importer";
import "./styles.css";

type ReqSection = "params" | "headers" | "body" | "query" | "message" | "examples" | "explore" | "auth" | "scripts" | "tests" | "settings";

const SECTIONS: Record<RequestKind, ReqSection[]> = {
  http: ["params", "headers", "body", "auth", "scripts", "tests", "examples", "settings"],
  graphql: ["query", "headers", "auth", "scripts", "tests", "examples", "settings"],
  sse: ["params", "headers", "body", "auth", "scripts", "settings"],
  ws: ["message", "headers", "auth", "settings"],
  grpc: ["message", "headers", "auth", "settings"],
  mcp: ["explore", "headers", "auth", "settings"],
};
const KIND_LABEL: Record<RequestKind, string> = { http: "HTTP", graphql: "GraphQL", sse: "SSE", ws: "WebSocket", grpc: "gRPC", mcp: "MCP" };
const pillOf = (t: RequestTab) => (t.kind === "http" ? t.method : t.kind === "graphql" ? "GQL" : t.kind === "grpc" ? "gRPC" : t.kind === "mcp" ? "MCP" : t.kind.toUpperCase());
type ResSection = "body" | "headers" | "cookies" | "tests" | "console";
type SideSection = "collections" | "history" | "environments";

const defaultEnvs: Environment[] = [
  { id: "env-local", name: "Local", vars: [emptyKV()] },
];

export default function App() {
  const [tabs, setTabs] = useState<RequestTab[]>(() => {
    const t = load<RequestTab[]>("rq.tabs", []).map(normalizeTab);
    return t.length ? t : [newTab()];
  });
  const [activeId, setActiveId] = useState<string>(() => load("rq.active", "") || "");
  const [envs, setEnvs] = useState<Environment[]>(() => load("rq.envs", defaultEnvs));
  const [envId, setEnvId] = useState<string>(() => load("rq.envId", "env-local"));
  const [history, setHistory] = useState<HistoryItem[]>(() => load<HistoryItem[]>("rq.history", []).map((h) => ({ ...h, tab: normalizeTab(h.tab) })));
  const [responses, setResponses] = useState<Record<string, ResponseData | { error: string } | null>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [reqSection, setReqSection] = useState<ReqSection>("params");
  const [resSection, setResSection] = useState<ResSection>("body");
  const [side, setSide] = useState<SideSection>(() => load("rq.side", "collections"));
  const [collection, setCollection] = useState<Collection | null>(() => load("rq.collection", null));
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedDir, setSelectedDir] = useState<string>(() => load<Collection | null>("rq.collection", null)?.root ?? "");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const writtenEnvs = useRef<Map<string, string>>(new Map());
  const tabsRef = useRef<RequestTab[]>([]);
  const sessionRef = useRef<Record<string, string>>({});
  const tokensRef = useRef<TokenCache>(new Map());
  const stopRef = useRef(false);
  const [tick, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  const [runs, setRuns] = useState<Record<string, RunOutput | null>>({});
  const [oauthBusy, setOauthBusy] = useState(false);
  const [streams, setStreams] = useState<Record<string, StreamState>>({});
  const [codegenOpen, setCodegenOpen] = useState(false);
  const [respHist, setRespHist] = useState<Record<string, HistEntry[]>>({});
  const [viewing, setViewing] = useState<Record<string, number | null>>({});
  const [diffOpen, setDiffOpen] = useState(false);
  const [mockOpen, setMockOpen] = useState(false);
  const [mockPort, setMockPort] = useState<number | null>(null);
  const [mockLog, setMockLog] = useState<MockHit[]>([]);
  const [mcpInfo, setMcpInfo] = useState<Record<string, McpInfo>>({});
  const [grpcSchemas, setGrpcSchemas] = useState<Record<string, GrpcSchema>>({});
  const entryN = useRef(0);
  const queue = useRef<Record<string, { entries: StreamEntry[]; patch: Partial<StreamState> }>>({});
  const flushing = useRef(false);
  const [gqlFetching, setGqlFetching] = useState<Record<string, boolean>>({});
  const [gqlError, setGqlError] = useState<Record<string, string | null>>({});
  const [runner, setRunner] = useState<RunState | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => load("rq.sidebar", true));
  const lastFired = useRef<{ id: string; at: number }>({ id: "", at: 0 });
  const actions = useRef<Record<string, () => void>>({});
  const [chain, setChain] = useState<ChainLink[]>([]);
  const [chainVer, setChainVer] = useState(0);
  const [defaultsEdit, setDefaultsEdit] = useState<{ dir: string; title: string; tab: RequestTab } | null>(null);
  const [splitPct, setSplitPct] = useState<number>(() => load("rq.split", 40));
  const reqPanel = useRef<HTMLElement>(null);
  const resPanel = useRef<HTMLElement>(null);
  const [rawView, setRawView] = useState(false);
  const [wrapRes, setWrapRes] = useState(true);
  const urlView = useRef<EditorView | null>(null);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const env = envs.find((e) => e.id === envId);
  const sections = SECTIONS[active?.kind ?? "http"];
  const section: ReqSection = sections.includes(reqSection) ? reqSection : sections[0];
  const isBlank = (t: RequestTab) =>
    t.kind === "http" && !t.url.trim() && !t.body && !t.file && t.params.every((r) => !r.key) && t.headers.every((r) => !r.key) &&
    (t.authMode === "none" || t.authMode === "inherit") && !t.preScript && !t.postScript && !t.assertions.length && !t.examples.length;
  const showWelcome = !!active && isBlank(active) && !responses[active.id] && !loading[active.id] && !streams[active.id];
  const isStreamKind = active?.kind === "ws" || active?.kind === "sse" || active?.kind === "grpc" || active?.kind === "mcp";
  const streamState = (active && streams[active.id]) || EMPTY_STREAM;
  const streamStatus = streamState.status;
  const hist = (active && respHist[active.id]) || [];
  const viewIdx = active ? (viewing[active.id] ?? null) : null;
  const latestResponse = active ? responses[active.id] : null;
  const response = viewIdx !== null && hist[viewIdx] ? hist[viewIdx].response : latestResponse;
  const run = active ? runs[active.id] : null;

  useEffect(() => {
    tabsRef.current = tabs;
    save("rq.tabs", tabs);
  }, [tabs]);
  useEffect(() => save("rq.active", active?.id ?? ""), [active?.id]);
  useEffect(() => {
    if (!collection) save("rq.envs", envs);
  }, [envs, collection]);
  useEffect(() => save("rq.side", side), [side]);
  useEffect(() => save("rq.collection", collection), [collection]);
  useEffect(() => save("rq.envId", envId), [envId]);
  useEffect(() => save("rq.history", history.slice(0, settings.historyLimit)), [history, settings.historyLimit]);

  const ask = (title: string, initial = "", confirm = "Create", label?: string) =>
    new Promise<string | null>((resolve) =>
      setDialog({ kind: "prompt", title, initial, confirm, label, resolve: (v) => (setDialog(null), resolve(v)) }),
    );
  const confirmDialog = (title: string, message: string, confirm = "Delete") =>
    new Promise<boolean>((resolve) =>
      setDialog({ kind: "confirm", title, message, confirm, danger: true, resolve: (v) => (setDialog(null), resolve(v)) }),
    );
  const choose = (title: string, options: { id: string; label: string; hint?: string }[]) =>
    new Promise<string | null>((resolve) =>
      setDialog({ kind: "menu", title, options, resolve: (v) => (setDialog(null), resolve(v)) }),
    );
  const info = (title: string, message: string) =>
    new Promise<void>((resolve) => setDialog({ kind: "info", title, message, resolve: () => (setDialog(null), resolve()) }));
  const flash = (msg: string, ms = 1800) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), ms);
  };
  const guard = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      await info("Something went wrong", String(e));
    }
  };

  const refreshTree = useCallback(async () => {
    if (!collection) return setTree([]);
    try {
      setTree(await listTree(collection.root));
    } catch {
      setTree([]);
    }
  }, [collection]);

  const loadCollection = async (root: string) => {
    const name = (await readCollectionName(root)) ?? basename(root);
    setCollection({ root, name });
    setSelectedDir(root);
    const loaded = await loadEnvironments(root);
    writtenEnvs.current = new Map();
    setEnvs(loaded.length ? loaded : []);
    setEnvId(loaded[0]?.id ?? "");
    setSide("collections");
  };

  const openCollection = () =>
    guard(async () => {
      const root = await pickFolder("Open a collection folder");
      if (!root) return;
      if ((await readCollectionName(root)) === null) {
        const ok = await confirmDialog(
          "Not a Reqnest collection yet",
          `"${basename(root)}" has no reqnest.yaml. Turn this folder into a collection? Existing files are left untouched.`,
        ).catch(() => false);
        if (!ok) return;
        await initCollection(root, basename(root));
      }
      await loadCollection(root);
    });

  const newCollection = () =>
    guard(async () => {
      const parent = await pickFolder("Choose where to create the collection");
      if (!parent) return;
      const name = await ask("New collection", "My API", "Create");
      if (!name) return;
      const root = await uniquePath(parent, slug(name), "");
      await makeDir(root);
      await initCollection(root, name);
      await loadCollection(root);
    });

  const closeCollection = () => {
    setCollection(null);
    setTree([]);
    setEnvs(load("rq.envs", defaultEnvs));
    setEnvId("env-local");
  };

  const openFile = (path: string) =>
    guard(async () => {
      const existing = tabs.find((t) => t.file === path);
      if (existing) return setActiveId(existing.id);
      const text = await readText(path);
      if (text === null) throw new Error("File no longer exists");
      addTab(parseRequest(text, path));
    });

  const writeTab = async (tab: RequestTab, file: string) => {
    const text = serializeRequest(tab);
    await writeText(file, text);
    setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, file, saved: text } : t)));
  };

  const saveTab = (tab: RequestTab) =>
    guard(async () => {
      if (tab.file) {
        await writeTab(tab, tab.file);
        return flash("Saved");
      }
      if (!collection) {
        await info("Open a collection first", "Create or open a collection folder (Collections tab) to save requests as files.");
        return setSide("collections");
      }
      const name = await ask("Save request", tab.name === "New request" ? "" : tab.name, "Save", "Saved as a plain YAML file in your collection.");
      if (!name) return;
      const file = await requestPath(selectedDir || collection.root, name);
      await writeTab({ ...tab, name }, file);
      setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, name } : t)));
      await refreshTree();
      flash("Saved");
    });

  /* ------------------------------- import ------------------------------- */

  const reloadEnvs = async (preferFile?: string) => {
    if (!collection) return;
    const loaded = await loadEnvironments(collection.root);
    writtenEnvs.current = new Map();
    setEnvs(loaded);
    setEnvId(preferFile && loaded.some((e) => e.id === preferFile) ? preferFile : (loaded.find((e) => e.id === envId)?.id ?? loaded[0]?.id ?? ""));
  };

  const summarize = (head: string, s: { created: number; updated: number; unchanged: number; removed: string[] }, notes: string[]) => {
    const lines = [head, "", `Created ${s.created}, updated ${s.updated}, unchanged ${s.unchanged}.`];
    if (s.removed.length)
      lines.push("", `No longer in the spec (kept, delete if unwanted): ${s.removed.slice(0, 6).join(", ")}${s.removed.length > 6 ? `, +${s.removed.length - 6} more` : ""}`);
    if (notes.length) lines.push("", ...notes.slice(0, 5).map((n) => `• ${n}`), ...(notes.length > 5 ? [`• +${notes.length - 5} more`] : []));
    return lines.join("\n");
  };

  const fetchSpec = async (url: string) => {
    const res = await sendRaw({ method: "GET", url, headers: [["Accept", "application/json, application/yaml, text/yaml, */*"]], body: null, timeoutMs: 30000, insecure: false, followRedirects: true });
    if (res.status >= 400) throw new Error(`Fetching the spec failed: HTTP ${res.status} ${res.statusText}`);
    return res.body;
  };

  const importOpenApi = async (source: string, sync: boolean) => {
    if (!collection) return;
    const text = /^https?:\/\//i.test(source) ? await fetchSpec(source) : await readText(source);
    if (text === null) throw new Error(`Couldn't read ${source}`);
    const parsed = parseOpenApi(text);
    const summary = await writeImport(collection.root, parsed.requests, sync);
    const env = await ensureEnvironment(collection.root, parsed.title, parsed.vars, ["clientSecret", "token", "password", "apiKey"]);
    const meta = (await readCollectionMeta(collection.root)) ?? { name: collection.name };
    await writeCollectionMeta(collection.root, { ...meta, openapi: { source } });
    await reloadEnvs(env.id);
    await refreshTree();
    await info(`${parsed.title}: imported`, summarize(`Environment "${env.name}" has {{baseUrl}} and the variables the requests use.`, summary, parsed.notes));
  };

  const importMenu = () =>
    guard(async () => {
      if (!collection) return;
      const meta = await readCollectionMeta(collection.root);
      const choice = await choose("Import into this collection", [
        ...(meta?.openapi ? [{ id: "resync", label: "Re-sync OpenAPI", hint: meta.openapi.source }] : []),
        { id: "oas-url", label: "OpenAPI / Swagger from URL", hint: "JSON or YAML, v2 or v3" },
        { id: "oas-file", label: "OpenAPI / Swagger from file" },
        { id: "postman", label: "Postman collection", hint: "v2.0 / v2.1 JSON export" },
        { id: "bruno", label: "Bruno collection", hint: "pick the collection folder" },
      ]);
      if (!choice) return;
      if (choice === "resync" && meta?.openapi) return importOpenApi(meta.openapi.source, true);
      if (choice === "oas-url") {
        const url = await ask("OpenAPI URL", "", "Import", "e.g. https://petstore3.swagger.io/api/v3/openapi.json");
        if (url) await importOpenApi(url, true);
      }
      if (choice === "oas-file") {
        const f = await pickFile("Choose an OpenAPI file", ["json", "yaml", "yml"]);
        if (f) await importOpenApi(f, true);
      }
      if (choice === "postman") {
        const f = await pickFile("Choose a Postman collection", ["json"]);
        if (!f) return;
        const parsed = parsePostman((await readText(f)) ?? "");
        const summary = await writeImport(collection.root, parsed.requests, false);
        if (Object.keys(parsed.vars).length) await reloadEnvs((await ensureEnvironment(collection.root, parsed.title, parsed.vars)).id);
        await refreshTree();
        await info(`${parsed.title}: imported`, summarize("Postman collection imported.", summary, parsed.notes));
      }
      if (choice === "bruno") {
        const dir = await pickFolder("Choose the Bruno collection folder");
        if (!dir) return;
        const reqs: ImportedRequest[] = [];
        const notes: string[] = [];
        let envFile: string | undefined;
        for (const file of await listFilesRecursive(dir, ".bru")) {
          const rel = file.slice(dir.length + 1).split("/");
          const text = (await readText(file)) ?? "";
          if (rel[0] === "environments") {
            const { vars } = parseBruEnv(text);
            const name = rel[rel.length - 1].replace(/\.bru$/, "");
            const secrets = vars.filter((v) => v.secret).map((v) => v.key);
            envFile = (await ensureEnvironment(collection.root, name, Object.fromEntries(vars.map((v) => [v.key, v.value])), secrets)).id;
            continue;
          }
          const r = parseBru(text, rel.slice(0, -1), rel[rel.length - 1]);
          if (r) {
            reqs.push(r.req);
            notes.push(...r.notes);
          }
        }
        const summary = await writeImport(collection.root, reqs, false);
        await reloadEnvs(envFile);
        await refreshTree();
        await info("Bruno collection imported", summarize(`${basename(dir)} imported.`, summary, notes));
      }
    });

  const applyCurl = (text: string) => {
    const { tab: c, notes } = parseCurl(text);
    patch({
      method: c.method, url: c.url, headers: c.headers, params: [emptyKV()], bodyMode: c.bodyMode, body: c.body,
      authMode: c.authMode, authUser: c.authUser, authPass: c.authPass, authToken: "",
      insecure: c.insecure, followRedirects: c.followRedirects, timeoutMs: c.timeoutMs,
    });
    flash(notes.length ? `Imported cURL — ${notes[0]}` : "Imported cURL command");
  };

  const newRequestIn = (dir: string) =>
    guard(async () => {
      const name = await ask("New request", "", "Create");
      if (!name) return;
      const file = await requestPath(dir, name);
      const tab = { ...newTab(), name, authMode: "inherit" as const };
      await writeTab(tab, file);
      await refreshTree();
      addTab({ ...tab, file, saved: serializeRequest(tab) });
    });

  const newFolderIn = (dir: string) =>
    guard(async () => {
      const name = await ask("New folder", "", "Create");
      if (!name) return;
      await makeDir(await uniquePath(dir, slug(name), ""));
      await refreshTree();
    });

  const renameNode = (node: TreeNode) =>
    guard(async () => {
      const isReq = !node.isDir;
      const current = isReq ? node.name.replace(/\.req\.ya?ml$/, "") : node.name;
      const name = await ask(isReq ? "Rename request" : "Rename folder", current, "Rename");
      if (!name || name === current) return;
      const dir = dirname(node.path);
      const target = isReq ? await requestPath(dir, name) : await uniquePath(dir, slug(name), "");
      if (isReq) {
        const text = await readText(node.path);
        const tab = parseRequest(text ?? "", node.path);
        const renamed = serializeRequest({ ...tab, name });
        await writeText(target, renamed);
        await removePath(node.path);
        setTabs((ts) => ts.map((t) => (t.file === node.path ? { ...t, file: target, name, saved: renamed } : t)));
      } else {
        await renamePath(node.path, target);
        setTabs((ts) => ts.map((t) => (t.file?.startsWith(node.path + "/") ? { ...t, file: target + t.file.slice(node.path.length) } : t)));
        if (selectedDir.startsWith(node.path)) setSelectedDir(collection!.root);
      }
      await refreshTree();
    });

  const duplicateNode = (node: TreeNode) =>
    guard(async () => {
      const text = await readText(node.path);
      const tab = parseRequest(text ?? "", node.path);
      const name = `${tab.name} copy`;
      await writeText(await requestPath(dirname(node.path), name), serializeRequest({ ...tab, name }));
      await refreshTree();
    });

  const deleteNode = (node: TreeNode) =>
    guard(async () => {
      const ok =
        !settings.confirmDelete ||
        (await confirmDialog(
          node.isDir ? "Delete folder" : "Delete request",
          node.isDir ? `"${node.name}" and everything inside it will be deleted from disk.` : `"${node.name}" will be deleted from disk.`,
        ));
      if (!ok) return;
      await removePath(node.path);
      setTabs((ts) => {
        const keep = ts.filter((t) => !(t.file === node.path || t.file?.startsWith(node.path + "/")));
        return keep.length ? keep : [newTab()];
      });
      if (selectedDir === node.path) setSelectedDir(collection!.root);
      await refreshTree();
    });

  const patch = useCallback(
    (p: Partial<RequestTab>) => setTabs((ts) => ts.map((t) => (t.id === active.id ? { ...t, ...p } : t))),
    [active?.id],
  );

  // Initial load of the collection remembered from last session.
  useEffect(() => {
    if (collection) {
      loadEnvironments(collection.root).then((e) => {
        setEnvs(e);
        setEnvId((cur) => (e.some((x) => x.id === cur) ? cur : (e[0]?.id ?? "")));
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    refreshTree();
  }, [refreshTree]);

  // Pick up changes made outside the app (git pull, editor): refresh tree and reload clean tabs.
  useEffect(() => {
    const onFocus = async () => {
      setChainVer((v) => v + 1);
      await refreshTree();
      const current = tabsRef.current;
      for (const t of current) {
        if (!t.file || t.saved == null || serializeRequest(t) !== t.saved) continue;
        const text = await readText(t.file).catch(() => null);
        if (text === null) continue;
        const fresh = parseRequest(text, t.file);
        if (fresh.saved !== t.saved) setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...fresh, id: t.id } : x)));
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshTree]);

  // Persist environment edits into the collection (debounced).
  useEffect(() => {
    if (!collection) return;
    const timer = setTimeout(async () => {
      for (const e of envs) {
        const sig = JSON.stringify([e.name, e.vars.map((v) => [v.key, v.value, v.enabled, v.secret])]);
        if (writtenEnvs.current.get(e.id) === sig) continue;
        try {
          const file = await saveEnvironment(collection.root, e);
          writtenEnvs.current.set(e.id, sig);
          if (e.file !== file) {
            writtenEnvs.current.set(file, sig);
            setEnvs((all) => all.map((x) => (x.id === e.id ? { ...x, id: file, file } : x)));
            setEnvId((cur) => (cur === e.id ? file : cur));
          }
        } catch {
          /* surfaced on next explicit action */
        }
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [envs, collection]);

  // Defaults inherited by the active request (read fresh from disk, so external edits count).
  useEffect(() => {
    let live = true;
    if (collection && active?.file)
      loadChain(collection.root, active.file, collection.name).then((c) => live && setChain(c)).catch(() => live && setChain([]));
    else setChain([]);
    return () => {
      live = false;
    };
  }, [collection, active?.file, chainVer]);
  const layersOf = (c: ChainLink[]): Layer[] => c.map((l) => ({ label: l.label, defaults: l.defaults }));
  const inherited = useMemo(() => (active ? applyDefaults(active, layersOf(chain)) : null), [active, chain]);
  useEffect(() => save("rq.split", splitPct), [splitPct]);

  const freshLayers = async (tab: RequestTab): Promise<Layer[]> =>
    collection && tab.file ? layersOf(await loadChain(collection.root, tab.file, collection.name).catch(() => [])) : [];

  const openDefaults = (dir: string, title: string) =>
    guard(async () => setDefaultsEdit({ dir, title, tab: await loadDefaults(dir) }));

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      const a = reqPanel.current?.getBoundingClientRect();
      const b = resPanel.current?.getBoundingClientRect();
      if (!a || !b) return;
      const total = b.bottom - a.top;
      setSplitPct(Math.min(80, Math.max(15, ((ev.clientY - a.top) / total) * 100)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const addTab = (t?: RequestTab) => {
    const tab = t ?? newTab();
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  };

  const closeTab = (id: string) => {
    if (streams[id]) {
      streamStop(id).catch(() => {});
      mcpClose(id).catch(() => {});
      unsubscribe(id);
      setStreams((m) => {
        const { [id]: _drop, ...rest } = m;
        return rest;
      });
    }
    setTabs((ts) => {
      const next = ts.filter((t) => t.id !== id);
      if (!next.length) {
        const fresh = newTab();
        setActiveId(fresh.id);
        return [fresh];
      }
      if (id === active.id) setActiveId(next[Math.max(0, ts.findIndex((t) => t.id === id) - 1)].id);
      return next;
    });
  };

  /* ------------------------- streams (SSE / WebSocket) ------------------------- */

  /** Incoming events are batched per animation frame so a chatty stream can't flood React with renders. */
  const flushStreams = () => {
    flushing.current = false;
    const q = queue.current;
    queue.current = {};
    setStreams((m) => {
      const next = { ...m };
      for (const [id, { entries, patch: sp }] of Object.entries(q)) {
        const cur = next[id] ?? EMPTY_STREAM;
        let all = entries.length ? [...cur.entries, ...entries] : cur.entries;
        let dropped = cur.dropped;
        if (all.length > MAX_ENTRIES) {
          dropped += all.length - MAX_ENTRIES;
          all = all.slice(-MAX_ENTRIES);
        }
        next[id] = {
          ...cur,
          ...sp,
          entries: all,
          dropped,
          received: cur.received + entries.filter((e) => e.dir === "in").length,
          sent: cur.sent + entries.filter((e) => e.dir === "out").length,
        };
      }
      return next;
    });
  };
  const pushStream = (id: string, entries: Omit<StreamEntry, "n" | "at">[], sp: Partial<StreamState> = {}) => {
    const at = Date.now();
    const cur = queue.current[id] ?? { entries: [], patch: {} };
    cur.entries.push(...entries.map((e) => ({ ...e, n: ++entryN.current, at })));
    Object.assign(cur.patch, sp);
    queue.current[id] = cur;
    if (!flushing.current) {
      flushing.current = true;
      setTimeout(flushStreams, 40); // not rAF: that stops entirely when the window is in the background
    }
  };

  const onStreamEvent = (id: string, e: StreamEvent) => {
    switch (e.type) {
      case "open":
        if (e.headers !== undefined) {
          const h = (e.headers as [string, string][]).map(([k, v]) => `${k}: ${v}`).join("\n");
          pushStream(id, h ? [{ dir: "sys", label: "headers", text: h }] : [], { status: "open" });
          break;
        }
        pushStream(id, [{ dir: "sys", label: "connected", text: e.protocol ? `Subprotocol: ${e.protocol}` : `HTTP ${e.status} ${e.statusText ?? ""}`.trim() }], { status: "open", info: e.sse === false ? `HTTP ${e.status} (not an event stream)` : e.status ? `HTTP ${e.status}` : e.protocol ? `protocol ${e.protocol}` : "", startedAt: Date.now() });
        break;
      case "sent":
        pushStream(id, [{ dir: "out", label: rpcLabel(e.text), text: e.text, size: new TextEncoder().encode(e.text).length }]);
        break;
      case "stderr":
        pushStream(id, [{ dir: "sys", label: "stderr", text: e.text }]);
        break;
      case "event":
        pushStream(id, [{ dir: "in", label: e.event, text: e.data, size: new TextEncoder().encode(e.data).length }]);
        break;
      case "raw":
        pushStream(id, [{ dir: "in", label: "data", text: e.text, size: new TextEncoder().encode(e.text).length }]);
        break;
      case "message":
        pushStream(id, [{ dir: "in", label: tabsRef.current.find((t) => t.id === id)?.kind === "mcp" ? rpcLabel(e.text) : "text", text: e.text, size: new TextEncoder().encode(e.text).length }]);
        break;
      case "binary":
        pushStream(id, [{ dir: "in", label: "binary", text: e.preview, size: e.size }]);
        break;
      case "close":
        if (e.codeName !== undefined) {
          // gRPC call finished: status line first, trailers underneath
          const ok = e.code === 0;
          const trailers = (e.trailers as [string, string][]).map(([k, v]) => `${k}: ${v}`).join("\n");
          pushStream(id, [{ dir: "sys", label: e.codeName, text: `${ok ? "Call finished" : e.message || "Call failed"} · ${e.ms} ms${trailers ? `\n${trailers}` : ""}`, tone: ok ? undefined : "error" }], { status: ok ? "closed" : "error", info: `${e.codeName}` });
        } else pushStream(id, [{ dir: "sys", label: "closed", text: `${e.code}${e.reason ? ` ${e.reason}` : ""}` }], { status: "closed" });
        unsubscribe(id);
        break;
      case "warn":
        pushStream(id, [{ dir: "sys", label: "warning", text: e.message, tone: "error" }]);
        break;
      case "end":
        pushStream(id, [{ dir: "sys", label: "ended", text: "The server closed the stream" }], { status: "closed" });
        unsubscribe(id);
        break;
      case "error":
        pushStream(id, [{ dir: "sys", label: "error", text: e.message, tone: "error" }], { status: "error" });
        unsubscribe(id);
        break;
    }
  };

  const grpcTarget = (tab: RequestTab, url: string) => ({ url, tls: tab.grpc.tls, insecure: tab.insecure, timeoutMs: tab.timeoutMs });
  const grpcSource = (tab: RequestTab, headers: [string, string][]) =>
    tab.grpc.source === "reflection" ? ({ kind: "reflection", metadata: headers } as const) : ({ kind: "proto", files: tab.grpc.protoFiles, includes: tab.grpc.importPaths } as const);

  const loadGrpcSchema = async () => {
    const tab = active;
    setGrpcSchemas((m) => ({ ...m, [tab.id]: { services: m[tab.id]?.services ?? [], loading: true, error: null } }));
    try {
      const prep = await prepareRequest({ ...tab, preScript: "", postScript: "" }, { env, session: sessionRef.current, tokens: tokensRef.current, onSession: bump, layers: await freshLayers(tab) });
      if (prep.error !== undefined) throw new Error(prep.error);
      const services = await grpcDescribe(grpcTarget(tab, prep.spec.url), grpcSource(tab, prep.spec.headers));
      setGrpcSchemas((m) => ({ ...m, [tab.id]: { services, loading: false, error: null } }));
    } catch (e) {
      setGrpcSchemas((m) => ({ ...m, [tab.id]: { services: [], loading: false, error: String((e as Error).message ?? e) } }));
    }
  };

  const connectStream = async (tab: RequestTab) => {
    if (!tab.url.trim() && !(tab.kind === "grpc" && tab.grpc.source === "proto") && !(tab.kind === "mcp" && tab.mcp.transport === "stdio")) return;
    if (tab.kind === "grpc" && !tab.grpc.method.trim()) return flash("Pick a method first", 2500);
    streamStop(tab.id).catch(() => {});
    pushStream(tab.id, [], { status: "connecting", info: "" });
    const prep = await prepareRequest(tab, { env, session: sessionRef.current, tokens: tokensRef.current, onSession: bump, layers: await freshLayers(tab) });
    if (prep.error !== undefined) return pushStream(tab.id, [{ dir: "sys", label: "error", text: prep.error, tone: "error" }], { status: "error" });
    setHistory((h) => [{ id: uid(), at: Date.now(), method: tab.method, url: tab.url, status: null, tab }, ...h].slice(0, settings.historyLimit));
    try {
      await subscribe(tab.id, (e) => onStreamEvent(tab.id, e));
      if (tab.kind === "mcp") {
        const sub = (x: string) => interpolate(x, prep.eff());
        const m = tab.mcp;
        const cfg =
          m.transport === "http"
            ? ({ transport: "http", url: prep.spec.url, headers: prep.spec.headers, insecure: tab.insecure, timeoutMs: tab.timeoutMs } as const)
            : ({ transport: "stdio", command: sub(m.command), args: splitArgs(sub(m.args)), env: m.env.filter((r) => r.enabled && r.key).map((r) => [r.key, sub(r.value)] as [string, string]) } as const);
        const init = await mcpConnect(tab.id, cfg);
        pushStream(tab.id, [{ dir: "sys", label: "connected", text: `${init?.serverInfo?.name ?? "MCP server"} ${init?.serverInfo?.version ?? ""} (protocol ${init?.protocolVersion})`.trim() }], { status: "open", info: init?.serverInfo?.name ?? "" });
        setMcpInfo((i) => ({ ...i, [tab.id]: { init, tools: [], resources: [], templates: [], prompts: [] } }));
        const full = await loadInfo(tab.id, init);
        setMcpInfo((i) => ({ ...i, [tab.id]: full }));
      } else if (tab.kind === "grpc") {
        const msg = interpolate(tab.grpc.message, prep.eff());
        pushStream(tab.id, [{ dir: "out", label: tab.grpc.method.split("/")[1] ?? "request", text: msg, size: new TextEncoder().encode(msg).length }]);
        await grpcCall(tab.id, {
          target: grpcTarget(tab, prep.spec.url),
          source: grpcSource(tab, prep.spec.headers),
          method: tab.grpc.method,
          messages: [msg],
          metadata: prep.spec.headers,
        });
      } else if (tab.kind === "sse") await sseConnect(tab.id, prep.spec);
      else
        await wsConnect(tab.id, {
          url: prep.spec.url,
          headers: prep.spec.headers,
          protocols: tab.ws.protocols.split(",").map((p) => p.trim()).filter(Boolean),
          insecure: tab.insecure,
        });
    } catch (e) {
      pushStream(tab.id, [{ dir: "sys", label: "error", text: String(e), tone: "error" }], { status: "error" });
    }
  };

  const disconnectStream = async (tab: RequestTab) => {
    try {
      if (tab.kind === "mcp") {
        await mcpClose(tab.id);
        setMcpInfo((i) => {
          const { [tab.id]: _x, ...rest } = i;
          return rest;
        });
        unsubscribe(tab.id);
        pushStream(tab.id, [{ dir: "sys", label: "disconnected", text: "You disconnected" }], { status: "closed" });
      } else if (tab.kind === "ws") await wsClose(tab.id);
      else {
        await streamStop(tab.id);
        unsubscribe(tab.id);
        pushStream(tab.id, [{ dir: "sys", label: "stopped", text: "You disconnected" }], { status: "closed" });
      }
    } catch {
      pushStream(tab.id, [], { status: "closed" });
    }
  };

  const sendWsMessage = async (text: string, mode: WsMode) => {
    const tab = active;
    const body = interpolate(text, withSession(env, sessionRef.current));
    try {
      if (mode === "json") JSON.parse(body);
    } catch (e) {
      return flash(`Not valid JSON: ${(e as Error).message}`, 3500);
    }
    try {
      if (mode === "binary") {
        const b64 = body.replace(/\s+/g, "");
        await wsSend(tab.id, { base64: b64 });
        pushStream(tab.id, [{ dir: "out", label: "binary", text: b64, size: Math.floor((b64.length * 3) / 4) }]);
      } else {
        await wsSend(tab.id, { text: body });
        pushStream(tab.id, [{ dir: "out", label: mode, text: body, size: new TextEncoder().encode(body).length }]);
      }
    } catch (e) {
      pushStream(tab.id, [{ dir: "sys", label: "error", text: String(e), tone: "error" }]);
    }
  };

  /* ------------------------------ mock server ------------------------------ */

  const mockListening = useRef(false);
  /** Subscribed on first start (not at launch), and kept for the session so the log survives closing the dialog. */
  const ensureMockListener = async () => {
    if (mockListening.current) return;
    mockListening.current = true;
    try {
      await listen<Omit<MockHit, "n" | "at">>("mock", (e) => setMockLog((l) => [...l, { ...e.payload, n: ++entryN.current, at: Date.now() }].slice(-300)));
    } catch {
      mockListening.current = false;
    }
  };

  const startMock = async (port: number, includeEmpty: boolean) => {
    if (!collection) return;
    const routes = await buildRoutes(collection.root, includeEmpty);
    if (!routes.length) throw new Error("No requests with examples to serve");
    await ensureMockListener();
    setMockPort(await mockStart(port, routes));
  };
  const stopMock = () => {
    void mockStop();
    setMockPort(null);
  };

  /** Keep the response as a documented example (and the mock's answer for this request). */
  const saveAsExample = () =>
    guard(async () => {
      if (!response || "error" in response) return;
      const name = await ask("Save as example", `${response.status} ${response.statusText}`.trim(), "Save", "Examples are stored in the request file and served by the mock server.");
      if (!name) return;
      const drop = new Set(["content-length", "transfer-encoding", "connection", "content-encoding", "date", "server", "set-cookie", "keep-alive", "vary", "etag", "age"]);
      const headers = response.headers.filter(([k]) => !drop.has(k.toLowerCase())).map(([key, value]) => ({ ...emptyKV(), key, value }));
      patch({
        examples: [
          ...active.examples,
          { id: uid(), name, status: response.status, headers: [...headers, emptyKV()], body: response.bodyBase64 ? "" : (resBody?.pretty ?? response.body), delayMs: 0 },
        ],
      });
      flash(response.bodyBase64 ? "Saved (binary bodies aren't stored, only status and headers)" : "Saved as example", 2600);
    });

  const send = useCallback(async () => {
    if (!active || (!active.url.trim() && !(active.kind === "grpc" && active.grpc.source === "proto") && !(active.kind === "mcp" && active.mcp.transport === "stdio"))) return;
    const tab = active;
    if (tab.kind === "ws" || tab.kind === "sse" || tab.kind === "grpc" || tab.kind === "mcp") {
      const st = streams[tab.id]?.status;
      if (tab.kind === "ws" && st === "open" && tab.ws.composer.trim()) {
        let isJson = true;
        try {
          JSON.parse(tab.ws.composer);
        } catch {
          isJson = false;
        }
        return void sendWsMessage(tab.ws.composer, isJson ? "json" : "text");
      }
      return void connectStream(tab);
    }
    setLoading((l) => ({ ...l, [tab.id]: true }));
    setResponses((r) => ({ ...r, [tab.id]: null }));
    setRuns((r) => ({ ...r, [tab.id]: null }));
    let status: number | null = null;
    try {
      const out = await executeRequest(tab, { env, session: sessionRef.current, tokens: tokensRef.current, onSession: bump, layers: await freshLayers(tab) });
      status = out.response?.status ?? null;
      if (out.sent) {
        const text = [out.sent.url, out.sent.body ?? "", ...out.sent.headers.flat()].join("\n");
        const missing = [...new Set([...text.matchAll(/\{\{\s*(\$?[\w.\-]+)\s*\}\}/g)].map((m) => m[1]))];
        if (missing.length) flash(`Undefined variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`, 4500);
      }
      setResponses((r) => ({ ...r, [tab.id]: out.response ?? { error: out.error ?? "Request failed" } }));
      setViewing((v) => ({ ...v, [tab.id]: null }));
      if (out.response) {
        const saved = out.response.sizeBytes > 2_000_000 ? { ...out.response, body: "(too large to keep in history)", bodyBase64: null } : out.response;
        setRespHist((h) => ({ ...h, [tab.id]: [...(h[tab.id] ?? []), { n: ++entryN.current, at: Date.now(), response: saved }].slice(-20) }));
      }
      setRuns((r) => ({ ...r, [tab.id]: out.run }));
      if (out.run.scriptError || out.run.tests.some((t) => !t.passed)) setResSection("tests");
    } finally {
      setLoading((l) => ({ ...l, [tab.id]: false }));
      setHistory((h) =>
        [{ id: uid(), at: Date.now(), method: tab.method, url: tab.url, status, tab }, ...h].slice(0, settings.historyLimit),
      );
    }
  }, [active, env]);

  const effOAuth = inherited?.tab.authMode === "oauth2" ? inherited.tab.oauth : null;
  /** Introspect the endpoint with the same auth, headers and scripts as the request itself. */
  const fetchSchema = async () => {
    const tab = active;
    setGqlFetching((m) => ({ ...m, [tab.id]: true }));
    setGqlError((m) => ({ ...m, [tab.id]: null }));
    try {
      const { getIntrospectionQuery } = await loadGraphQL();
      const probe = { ...tab, gql: { query: getIntrospectionQuery({ descriptions: true }), variables: "", operation: "" }, postScript: "", assertions: [], captures: [] };
      const out = await executeRequest(probe, { env, session: sessionRef.current, tokens: tokensRef.current, onSession: bump, layers: await freshLayers(tab) });
      if (!out.response) throw new Error(out.error ?? "Request failed");
      let json: any;
      try {
        json = JSON.parse(out.response.body);
      } catch {
        throw new Error(`The endpoint didn't return JSON (HTTP ${out.response.status})`);
      }
      if (!json?.data?.__schema) throw new Error(json?.errors?.[0]?.message ?? "No schema in the response. Introspection may be disabled on this server.");
      storeSchema(tab.url, json.data);
    } catch (e) {
      setGqlError((m) => ({ ...m, [tab.id]: String((e as Error).message ?? e) }));
    } finally {
      setGqlFetching((m) => ({ ...m, [tab.id]: false }));
      bump();
    }
  };

  /** The request as the code generator sees it: inherited headers/auth applied, variables resolved or left as {{name}}. */
  const buildSnippet = (resolve: boolean) => {
    const t = inherited?.tab ?? active;
    const extra: [string, string][] = t.authMode === "oauth2" ? [["Authorization", `${t.oauth.prefix || "Bearer"} <access_token>`]] : [];
    const spec = buildRequest(t, resolve ? withSession(env, sessionRef.current) : undefined, extra);
    return { method: spec.method, url: spec.url, headers: spec.headers, body: spec.body, multipart: spec.multipart, bodyFile: spec.bodyFile };
  };

  const oauthToken = effOAuth ? tokensRef.current.get(tokenKey(resolveOAuth(effOAuth, withSession(env, sessionRef.current)))) : undefined;

  const getTokenNow = async () => {
    setOauthBusy(true);
    try {
      await getToken(resolveOAuth((inherited?.tab ?? active).oauth, withSession(env, sessionRef.current)), tokensRef.current, { force: true });
    } catch (e) {
      await info("OAuth 2.0", String((e as Error).message ?? e));
    } finally {
      setOauthBusy(false);
      bump();
    }
  };
  const resetToken = () => {
    tokensRef.current.delete(tokenKey(resolveOAuth((inherited?.tab ?? active).oauth, withSession(env, sessionRef.current))));
    bump();
  };

  /** Run every request under a folder (or the whole collection), in file order, sharing session variables. */
  const runFolder = (dir: string, title: string) =>
    guard(async () => {
      const files = await listFilesRecursive(dir, ".req.yaml");
      if (!files.length) return info("Nothing to run", "There are no requests in here yet.");
      stopRef.current = false;
      const items: RunState["items"] = files.map((f) => ({ name: basename(f).replace(/\.req\.ya?ml$/, ""), state: "pending", passed: 0, failed: 0, failures: [] }));
      const render = (done = false) => setRunner({ title, items: items.map((i) => ({ ...i })), done });
      render();
      for (let i = 0; i < files.length && !stopRef.current; i++) {
        items[i].state = "running";
        render();
        try {
          const tab = parseRequest((await readText(files[i])) ?? "", files[i]);
          items[i].name = tab.name;
          const out = await executeRequest(tab, { env, session: sessionRef.current, tokens: tokensRef.current, onSession: bump, layers: await freshLayers(tab) });
          items[i].status = out.response?.status;
          items[i].ms = out.response?.timeMs;
          items[i].error = out.error;
          items[i].passed = out.run.tests.filter((t) => t.passed).length;
          items[i].failed = out.run.tests.filter((t) => !t.passed).length;
          items[i].failures = out.run.tests.filter((t) => !t.passed).map((t) => `${t.name}${t.error ? `: ${t.error}` : ""}`);
        } catch (e) {
          items[i].error = String(e);
        }
        items[i].state = "done";
        render();
      }
      render(true);
    });

  /* ---------------- settings, menu, shortcuts, palette ---------------- */

  const changeSettings = (p: Partial<Settings>) => setSettings((cur) => ({ ...cur, ...p }));
  useEffect(() => {
    saveSettings(settings);
    applyAppearance(settings);
    setNetwork(networkOf(settings));
    setTabDefaults({ timeoutMs: settings.timeoutMs, followRedirects: settings.followRedirects, insecure: !settings.verifyTls });
    try {
      void getCurrentWebview().setZoom(settings.zoom).catch(() => {});
    } catch {
      /* not running inside Tauri (browser preview) */
    }
  }, [settings]);
  useEffect(() => save("rq.sidebar", sidebarOpen), [sidebarOpen]);

  const nextTab = (d: number) => {
    const i = tabs.findIndex((t) => t.id === active.id);
    setActiveId(tabs[(i + d + tabs.length) % tabs.length].id);
  };
  const zoomBy = (d: number) => changeSettings({ zoom: Math.min(1.5, Math.max(0.8, Math.round((settings.zoom + d) * 100) / 100)) });

  actions.current = {
    settings: () => setSettingsOpen("general"),
    shortcuts: () => setSettingsOpen("shortcuts"),
    "new-request": () => addTab(),
    "new-collection": () => void newCollection(),
    "open-collection": () => void openCollection(),
    save: () => void saveTab(active),
    "close-tab": () => closeTab(active.id),
    import: () => (collection ? void importMenu() : void info("Open a collection first", "Create or open a collection (Collections tab) to import into.")),
    send: () => void send(),
    "focus-url": () => {
      urlView.current?.focus();
      urlView.current?.dispatch({ selection: { anchor: 0, head: urlView.current.state.doc.length } });
    },
    "duplicate-tab": () => addTab({ ...active, id: uid(), file: null, saved: null, name: "New request" }),
    "next-tab": () => nextTab(1),
    "prev-tab": () => nextTab(-1),
    "run-collection": () => (collection ? void runFolder(collection.root, `Run ${collection.name}`) : void info("No collection open", "Open a collection to run its requests.")),
    palette: () => setPaletteOpen(true),
    mock: () => (collection ? setMockOpen(true) : void info("Open a collection first", "The mock server serves the saved examples of a collection's requests.")),
    codegen: () => (active.kind === "ws" || active.kind === "grpc" ? flash("Code generation isn't available for this request type") : setCodegenOpen(true)),
    "toggle-sidebar": () => setSidebarOpen((v) => !v),
    "zoom-in": () => zoomBy(0.1),
    "zoom-out": () => zoomBy(-0.1),
    "zoom-reset": () => changeSettings({ zoom: 1 }),
    "help-docs": () => void openUrl("https://github.com/batuhanilgarr/Reqnest#readme"),
    "help-github": () => void openUrl("https://github.com/batuhanilgarr/Reqnest"),
    "help-issue": () => void openUrl("https://github.com/batuhanilgarr/Reqnest/issues/new"),
  };

  /** Menu accelerators and the keydown fallback both land here; a repeat within 150 ms is the same keypress. */
  const fire = useCallback((id: string) => {
    const now = Date.now();
    if (lastFired.current.id === id && now - lastFired.current.at < 150) return;
    lastFired.current = { id, at: now };
    actions.current[id]?.();
  }, []);

  useEffect(() => {
    const un = listen<string>("menu", (e) => fire(e.payload)).catch(() => null);
    return () => {
      un.then((f) => f?.());
    };
  }, [fire]);

  useEffect(() => {
    const map: Record<string, string> = { Enter: "send", s: "save", t: "new-request", w: "close-tab", k: "palette", l: "focus-url", b: "toggle-sidebar", d: "duplicate-tab", ",": "settings", "/": "shortcuts", o: "open-collection", "=": "zoom-in", "-": "zoom-out", "0": "zoom-reset" };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        return fire("codegen");
      }
      const id = map[e.key.length === 1 ? e.key.toLowerCase() : e.key];
      if (!id) return;
      e.preventDefault();
      fire(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fire]);

  // Auto-save: write dirty, file-backed requests shortly after the last edit.
  useEffect(() => {
    if (!settings.autoSave) return;
    const timer = setTimeout(() => {
      for (const t of tabsRef.current) if (t.file && t.saved != null && serializeRequest(t) !== t.saved) void writeTab(t, t.file).catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
  }, [tabs, settings.autoSave]);

  const isDirty = (t: RequestTab) => !!t.file && t.saved != null && serializeRequest(t) !== t.saved;
  const dirtyFiles = useMemo(() => new Set(tabs.filter(isDirty).map((t) => t.file!)), [tabs]);
  const tabTitle = (t: RequestTab) => t.name !== "New request" ? t.name : t.url.replace(/^https?:\/\//, "") || "New request";

  const flatRequests = useMemo(() => {
    const out: { path: string; label: string }[] = [];
    const walk = (nodes: TreeNode[], trail: string[]) => {
      for (const n of nodes) {
        if (n.isDir) walk(n.children, [...trail, n.name]);
        else out.push({ path: n.path, label: [...trail, n.name.replace(/\.req\.ya?ml$/, "")].join(" / ") });
      }
    };
    walk(tree, []);
    return out;
  }, [tree]);

  const commands: Command[] = [
    { id: "a:send", group: "Action", title: "Send request", hint: "⌘↵", run: () => fire("send") },
    { id: "a:new", group: "Action", title: "New request", hint: "⌘T", run: () => fire("new-request") },
    { id: "a:save", group: "Action", title: "Save request", hint: "⌘S", run: () => fire("save") },
    { id: "a:dup", group: "Action", title: "Duplicate tab", hint: "⌘D", run: () => fire("duplicate-tab") },
    { id: "a:open", group: "Action", title: "Open collection…", hint: "⌘O", run: () => fire("open-collection") },
    { id: "a:newc", group: "Action", title: "New collection…", run: () => fire("new-collection") },
    { id: "a:import", group: "Action", title: "Import OpenAPI, Postman, Bruno…", run: () => fire("import") },
    { id: "a:run", group: "Action", title: "Run collection", run: () => fire("run-collection") },
    { id: "a:mock", group: "Action", title: mockPort ? `Mock server (running on :${mockPort})` : "Mock server…", run: () => fire("mock") },
    { id: "a:diff", group: "Action", title: "Compare responses of this request", run: () => (hist.length > 1 ? setDiffOpen(true) : flash("Send the request at least twice to compare responses")) },
    { id: "a:code", group: "Action", title: "Generate code for this request", hint: "⇧⌘G", run: () => fire("codegen") },
    { id: "a:side", group: "View", title: "Toggle sidebar", hint: "⌘B", run: () => fire("toggle-sidebar") },
    { id: "a:set", group: "App", title: "Settings", hint: "⌘,", run: () => fire("settings") },
    { id: "a:keys", group: "App", title: "Keyboard shortcuts", hint: "⌘/", run: () => fire("shortcuts") },
    { id: "t:system", group: "Theme", title: "Theme: System", run: () => changeSettings({ theme: "system" }) },
    { id: "t:light", group: "Theme", title: "Theme: Light", run: () => changeSettings({ theme: "light" }) },
    { id: "t:dark", group: "Theme", title: "Theme: Dark", run: () => changeSettings({ theme: "dark" }) },
    { id: "a:clearh", group: "Action", title: "Clear request history", run: () => setHistory([]) },
    ...envs.map((e) => ({ id: `e:${e.id}`, group: "Env", title: `Switch environment: ${e.name}`, run: () => setEnvId(e.id) })),
    ...tabs.map((t) => ({ id: `tab:${t.id}`, group: "Tab", title: tabTitle(t), hint: t.method, run: () => setActiveId(t.id) })),
    ...flatRequests.map((r) => ({ id: `r:${r.path}`, group: "Request", title: r.label, run: () => void openFile(r.path) })),
    ...(collection ? tree.filter((n) => n.isDir).map((n) => ({ id: `d:${n.path}`, group: "Folder", title: `Run folder: ${n.name}`, run: () => void runFolder(n.path, `Run ${n.name}`) })) : []),
  ];


  const counts = useMemo(
    () => ({
      params: active?.params.filter((p) => p.enabled && p.key).length ?? 0,
      headers: active?.headers.filter((p) => p.enabled && p.key).length ?? 0,
    }),
    [active],
  );

  /** What {{variables}} resolve to right now (secrets masked), for highlighting and hover. */
  const varMap = useMemo<VarMap>(() => {
    const m: VarMap = { ...DYNAMIC_DESCRIPTIONS };
    for (const v of env?.vars ?? []) if (v.enabled && v.key) m[v.key] = v.secret ? "•••••• (secret)" : v.value;
    for (const [k, v] of Object.entries(sessionRef.current)) m[k] = v;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, tick]);

  const resLang: Lang = useMemo(() => {
    if (!response || "error" in response) return "text";
    const ct = (response.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "").toLowerCase();
    if (ct.includes("json") || /^\s*[[{]/.test(response.body.slice(0, 20))) return "json";
    if (ct.includes("html")) return "html";
    if (ct.includes("xml")) return "xml";
    if (ct.includes("javascript")) return "js";
    return "text";
  }, [response]);

  const setCookies = useMemo(
    () => (!response || "error" in response ? [] : response.headers.filter(([k]) => k.toLowerCase() === "set-cookie").map(([, v]) => parseSetCookie(v))),
    [response],
  );

  const resBody = useMemo(() => {
    if (!response || "error" in response) return null;
    const pretty = tryPrettyJson(response.body);
    return { pretty, text: response.body };
  }, [response]);

  return (
    <div className={`app ${sidebarOpen ? "" : "no-side"}`}>
      <aside className="sidebar">
        <div className="titlebar-drag" data-tauri-drag-region />
        <div className="brand">
          <Logo size={20} /> Reqnest
        </div>
        <div className="seg">
          <button className={side === "collections" ? "on" : ""} onClick={() => setSide("collections")}>
            Collections
          </button>
          <button className={side === "history" ? "on" : ""} onClick={() => setSide("history")}>
            History
          </button>
          <button className={side === "environments" ? "on" : ""} onClick={() => setSide("environments")}>
            Environments
          </button>
        </div>
        <div className="side-body">
          {side === "collections" && (
            <>
              {!collection ? (
                <div className="pad empty">
                  <p>Collections are plain folders of YAML files you can commit to Git.</p>
                  <button className="btn primary block" onClick={newCollection}>New collection…</button>
                  <button className="btn block" onClick={openCollection}>Open folder…</button>
                </div>
              ) : (
                <>
                  <div className="coll-head">
                    <span className="coll-name" title={collection.root}>{collection.name}</span>
                    <span className="row-actions always">
                      <button title="New request" onClick={() => newRequestIn(selectedDir || collection.root)}>＋</button>
                      <button title="New folder" onClick={() => newFolderIn(selectedDir || collection.root)}>▤</button>
                      <button title="Collection defaults (headers, auth, scripts)" onClick={() => openDefaults(collection.root, `Defaults for “${collection.name}”`)}>⚙</button>
                      <button title={mockPort ? `Mock server (running on :${mockPort})` : "Mock server"} onClick={() => fire("mock")} className={mockPort ? "live" : ""}>⚑</button>
                      <button title="Run all requests" onClick={() => runFolder(collection.root, `Run ${collection.name}`)}>▶</button>
                      <button title="Import (OpenAPI, Postman, Bruno)" onClick={importMenu}>⇩</button>
                      <button title="Open another collection" onClick={openCollection}>⌂</button>
                      <button title="Close collection" onClick={closeCollection}>×</button>
                    </span>
                  </div>
                  {tree.length === 0 && <p className="muted pad">No requests yet. Click ＋ to add one, or press ⌘S on a request.</p>}
                  <Tree
                    nodes={tree}
                    activeFile={active.file ?? null}
                    selectedDir={selectedDir}
                    dirty={dirtyFiles}
                    onOpen={openFile}
                    onSelectDir={setSelectedDir}
                    onRun={(dir) => runFolder(dir, `Run ${basename(dir)}`)}
                    onDefaults={(dir) => openDefaults(dir, `Defaults for “${basename(dir)}”`)}
                    onNewRequest={newRequestIn}
                    onNewFolder={newFolderIn}
                    onRename={renameNode}
                    onDuplicate={duplicateNode}
                    onDelete={deleteNode}
                  />
                </>
              )}
            </>
          )}
          {side === "history" && (
            <>
              {history.length === 0 && <p className="muted pad">Sent requests will show up here.</p>}
              {history.map((h) => (
                <button key={h.id} className="hist" onClick={() => addTab({ ...h.tab, id: uid(), file: null, saved: null })}>
                  <span className={`m m-${pillOf(h.tab)}`}>{pillOf(h.tab)}</span>
                  <span className="hist-url">{h.url.replace(/^https?:\/\//, "")}</span>
                  {h.status !== null && <span className={`dot ${statusClass(h.status)}`}>{h.status}</span>}
                </button>
              ))}
              {history.length > 0 && (
                <button className="link pad" onClick={() => setHistory([])}>
                  Clear history
                </button>
              )}
            </>
          )}
          {side === "environments" && (
            <div className="pad">
              <div className="row">
                <select value={envId} onChange={(e) => setEnvId(e.target.value)}>
                  {envs.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
                <button
                  className="btn small"
                  onClick={() => {
                    const e: Environment = { id: uid(), name: envs.length ? `Env ${envs.length + 1}` : "Local", vars: [emptyKV()] };
                    setEnvs([...envs, e]);
                    setEnvId(e.id);
                  }}
                >
                  + New
                </button>
              </div>
              {Object.keys(sessionRef.current).length > 0 && (
                <div className="session">
                  <div className="row">
                    <b>Session variables</b>
                    <button className="link" onClick={() => { sessionRef.current = {}; tokensRef.current = new Map(); bump(); }}>Clear</button>
                  </div>
                  <p className="muted small">Set by scripts and captures. In memory only, never saved.</p>
                  {Object.entries(sessionRef.current).map(([k, v]) => (
                    <div key={k} className="sess-row" title={v}>
                      <code>{k}</code>
                      <span>{v.length > 40 ? v.slice(0, 40) + "…" : v}</span>
                    </div>
                  ))}
                </div>
              )}
              {!env && <p className="muted">No environments yet. Create one to use {"{{variables}}"}.</p>}
              {env && (
                <>
                  <input
                    className="cell name"
                    value={env.name}
                    onChange={(e) => setEnvs(envs.map((x) => (x.id === env.id ? { ...x, name: e.target.value } : x)))}
                  />
                  <p className="muted">
                    Use variables as <code>{"{{name}}"}</code> in URL, headers, body and auth.
                    {collection ? " Saved in environments/. 🔒 secrets stay local and are never committed." : ""}
                  </p>
                  <KVEditor
                    secrets={!!collection}
                    rows={env.vars}
                    keyPlaceholder="Variable"
                    onChange={(vars) => setEnvs(envs.map((x) => (x.id === env.id ? { ...x, vars } : x)))}
                  />
                  <button
                    className="link"
                    onClick={async () => {
                      if (settings.confirmDelete && !(await confirmDialog("Delete environment", `"${env.name}" will be removed.`))) return;
                      if (env.file) await removePath(env.file).catch(() => {});
                      const rest = envs.filter((x) => x.id !== env.id);
                      setEnvs(rest);
                      setEnvId(rest[0]?.id ?? "");
                    }}
                  >
                    Delete environment
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="side-foot">
          <button onClick={() => fire("palette")} title="Command palette (⌘K)">
            <span>⌕</span> Search <kbd>⌘K</kbd>
          </button>
          <button onClick={() => fire("settings")} title="Settings (⌘,)">
            <span>⚙</span> Settings
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="tabbar" data-tauri-drag-region>
          {tabs.map((t) => (
            <div key={t.id} className={`tab ${t.id === active.id ? "on" : ""}`} onClick={() => setActiveId(t.id)}>
              <span className={`m m-${pillOf(t)}`}>{pillOf(t)}</span>
              <span className="tab-title">{tabTitle(t)}</span>
              {isDirty(t) && <b className="unsaved">●</b>}
              <button
                className="icon-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
                aria-label="Close tab"
              >
                ×
              </button>
            </div>
          ))}
          <button className="icon-btn plus" onClick={() => addTab()} aria-label="New tab">
            +
          </button>
          <div className="spacer" />
          <select className="env-pick" value={envId} onChange={(e) => setEnvId(e.target.value)} title="Environment">
            {envs.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>

        <div className="urlbar">
          <select className="kind" value={active.kind} onChange={(e) => patch({ kind: e.target.value as RequestKind })} title="Request type">
            {(["http", "graphql", "sse", "ws", "grpc", "mcp"] as RequestKind[]).map((k) => (
              <option key={k} value={k}>{KIND_LABEL[k]}</option>
            ))}
          </select>
          {(active.kind === "http" || active.kind === "sse") && (
          <select className={`method m-${active.method}`} value={active.method} onChange={(e) => patch({ method: e.target.value })}>
            {METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          )}
          {active.kind === "mcp" && active.mcp.transport === "stdio" ? (
            <div className="url-static" title="Configured in the Explore tab">
              <span className="muted">stdio</span> {active.mcp.command || "command"} {active.mcp.args}
            </div>
          ) : (
          <CodeEditor
            singleLine
            className="url"
            value={active.url}
            vars={varMap}
            editorRef={urlView}
            placeholder={active.kind === "mcp" ? "https://example.com/mcp" : active.kind === "grpc" ? "localhost:50051  or  grpcs://api.example.com:443" : active.kind === "ws" ? "wss://example.com/socket" : "Enter URL, or paste a cURL command  (use {{variables}})"}
            onSubmit={send}
            onPasteText={(text) => {
              if (!looksLikeCurl(text)) return false;
              applyCurl(text);
              return true;
            }}
            onChange={(v) => (looksLikeCurl(v) ? applyCurl(v) : patch({ url: v }))}
          />
          )}
          {active.kind !== "ws" && active.kind !== "grpc" && (
            <button className="btn code-btn" onClick={() => fire("codegen")} title="Generate code (⇧⌘G)" aria-label="Generate code">
              {"</>"}
            </button>
          )}
          <button
            className={`btn primary ${isStreamKind && streamStatus === "open" ? "stop" : ""}`}
            onClick={() => (isStreamKind && (streamStatus === "open" || streamStatus === "connecting") ? void disconnectStream(active) : void send())}
            disabled={loading[active.id]}
          >
            {isStreamKind ? (streamStatus === "open" || streamStatus === "connecting" ? (active.kind === "grpc" ? "Cancel" : "Disconnect") : active.kind === "grpc" ? "Invoke" : "Connect") : loading[active.id] ? "Sending…" : "Send"}
            <kbd>⌘↵</kbd>
          </button>
        </div>

        {showWelcome ? (
          <div className="launch">
            <Welcome
              hasCollection={!!collection}
              onCurl={() => fire("focus-url")}
              onSample={(k) => {
                if (k === "get") patch({ url: "https://httpbin.org/get?hello=reqnest", method: "GET" });
                else if (k === "post") patch({ url: "https://httpbin.org/post", method: "POST", bodyMode: "json", body: '{\n  "name": "Reqnest",\n  "message": "Hello"\n}' });
                else patch({ kind: "graphql", url: "https://countries.trevorblades.com/graphql", gql: { query: "query {\n  country(code: \"TR\") {\n    name\n    capital\n    languages { name }\n  }\n}", variables: "", operation: "" } });
              }}
              onNewCollection={() => fire("new-collection")}
              onOpenCollection={() => fire("open-collection")}
              onImport={() => fire("import")}
              onPalette={() => fire("palette")}
              onSettings={() => fire("settings")}
            />
          </div>
        ) : (
        <>
        <section className="panel req" ref={reqPanel} style={{ flex: `0 0 ${splitPct}%` }}>
          <nav className="subtabs">
            {sections.map((s) => (
              <button key={s} className={section === s ? "on" : ""} onClick={() => setReqSection(s)}>
                {s === "headers" && active.kind === "grpc" ? "Metadata" : s[0].toUpperCase() + s.slice(1)}
                {s === "params" && counts.params > 0 && <i>{counts.params}</i>}
                {s === "headers" && counts.headers > 0 && <i>{counts.headers}</i>}
                {s === "scripts" && (active.preScript.trim() || active.postScript.trim()) && <i>●</i>}
                {s === "examples" && active.examples.length > 0 && <i>{active.examples.length}</i>}
                {s === "tests" && active.assertions.length + active.captures.length > 0 && <i>{active.assertions.length + active.captures.length}</i>}
              </button>
            ))}
          </nav>
          <div className={`panel-body ${section === "body" || reqSection === "scripts" ? "fill" : ""}`}>
            {section === "params" && <KVEditor rows={active.params} onChange={(params) => patch({ params })} />}
            {section === "headers" && (
              <>
                <KVEditor rows={active.headers} onChange={(headers) => patch({ headers })} />
                {inherited && inherited.inheritedHeaders.length > 0 && (
                  <div className="inherited">
                    <h4>Inherited</h4>
                    {inherited.inheritedHeaders.map((h, i) => (
                      <div key={i} className={`inh-row ${h.overridden ? "over" : ""}`}>
                        <code>{h.key}</code>
                        <span>{h.value}</span>
                        <em>{h.overridden ? "overridden here" : h.from}</em>
                      </div>
                    ))}
                    <p className="muted small">To switch one off for this request, add the same header above and untick it.</p>
                  </div>
                )}
              </>
            )}
            {section === "body" && (
              <div className="col">
                <div className="row">
                  {(["none", "json", "text", "form", "multipart", "binary"] as BodyMode[]).map((m) => (
                    <label key={m} className="radio">
                      <input type="radio" checked={active.bodyMode === m} onChange={() => patch({ bodyMode: m, ...(m === "binary" && active.bodyMode !== "binary" ? { body: "" } : {}) })} />
                      {m === "form" ? "form-urlencoded" : m === "multipart" ? "multipart/form-data" : m}
                    </label>
                  ))}
                  {active.bodyMode === "json" && (
                    <button
                      className="btn small"
                      onClick={() => {
                        const p = tryPrettyJson(active.body);
                        if (p) patch({ body: p });
                      }}
                    >
                      Prettify
                    </button>
                  )}
                </div>
                {active.bodyMode === "none" ? (
                  <p className="muted">This request has no body.</p>
                ) : active.bodyMode === "multipart" ? (
                  <MultipartEditor rows={active.formParts} onChange={(formParts) => patch({ formParts })} />
                ) : active.bodyMode === "binary" ? (
                  <div className="row">
                    <button
                      className="btn"
                      onClick={async () => {
                        const f = await pickAnyFile("Choose the file to send as the request body");
                        if (f) patch({ body: f });
                      }}
                    >
                      Choose file…
                    </button>
                    <span className="muted">{active.body ? active.body : "Sends the file's bytes as the raw body."}</span>
                  </div>
                ) : (
                  <div className="editor-slot">
                    <CodeEditor
                      className="boxed"
                      value={active.body}
                      lang={active.bodyMode === "json" ? "json" : "text"}
                      vars={varMap}
                      placeholder={active.bodyMode === "form" ? "key=value&other=value" : active.bodyMode === "json" ? '{ "hello": "world" }' : ""}
                      onChange={(v) => patch({ body: v })}
                    />
                  </div>
                )}
              </div>
            )}
            {section === "explore" && (
              <McpPanel
                tab={active}
                patch={patch}
                vars={varMap}
                connected={streamStatus === "open"}
                connecting={streamStatus === "connecting"}
                info={mcpInfo[active.id]}
                call={(method, params) => mcpRequest(active.id, method, params)}
              />
            )}
            {section === "examples" && <div className="examples-wrap"><ExamplesPanel tab={active} patch={patch} vars={varMap} /></div>}
            {section === "message" && active.kind === "grpc" && (
              <GrpcPanel
                tab={active}
                patch={patch}
                vars={varMap}
                schema={grpcSchemas[active.id]}
                active={streamStatus === "open" || streamStatus === "connecting"}
                onLoad={loadGrpcSchema}
                onSendMore={async (text) => {
                  const body = interpolate(text, withSession(env, sessionRef.current));
                  try {
                    await grpcSend(active.id, body);
                    pushStream(active.id, [{ dir: "out", label: active.grpc.method.split("/")[1] ?? "request", text: body, size: new TextEncoder().encode(body).length }]);
                  } catch (e) {
                    pushStream(active.id, [{ dir: "sys", label: "error", text: String(e), tone: "error" }]);
                  }
                }}
                onEndStream={() => void grpcEnd(active.id).then(() => pushStream(active.id, [{ dir: "sys", label: "half-close", text: "You ended the request stream" }])).catch(() => {})}
              />
            )}
            {section === "message" && active.kind === "ws" && (
              <WsPanel tab={active} patch={patch} vars={varMap} connected={streamStatus === "open"} onSend={(b, m) => void sendWsMessage(b, m)} onAskName={() => ask("Save message", "", "Save", "Give this message a short name.")} />
            )}
            {section === "query" && (
              <GraphQLPanel
                tab={active}
                patch={patch}
                vars={varMap}
                schema={cachedSchema(active.url)}
                fetching={!!gqlFetching[active.id]}
                schemaError={gqlError[active.id] ?? null}
                onFetchSchema={fetchSchema}
              />
            )}
            {section === "auth" && (
              <AuthPanel tab={active} patch={patch} token={oauthToken} busy={oauthBusy} onGetToken={getTokenNow} onResetToken={resetToken} inheritFrom={active.file && collection ? (inherited?.authFrom ?? null) : undefined} />
            )}
            {section === "scripts" && <ScriptsPanel tab={active} patch={patch} vars={varMap} />}
            {section === "tests" && <TestsPanel tab={active} patch={patch} />}
            {section === "settings" && (
              <div className="col">
                {active.kind === "ws" && (
                  <label className="field">
                    <span>Subprotocols (comma-separated)</span>
                    <input className="cell" placeholder="graphql-transport-ws, chat" value={active.ws.protocols} spellCheck={false} onChange={(e) => patch({ ws: { ...active.ws, protocols: e.target.value } })} />
                  </label>
                )}
                {active.kind === "grpc" && (
                  <label className="check">
                    <input type="checkbox" checked={active.grpc.tls} onChange={(e) => patch({ grpc: { ...active.grpc, tls: e.target.checked } })} />
                    Use TLS when the address has no grpc:// or grpcs:// prefix
                  </label>
                )}
                {active.kind !== "ws" && active.kind !== "grpc" && (
                <label className="check">
                  <input type="checkbox" checked={active.followRedirects} onChange={(e) => patch({ followRedirects: e.target.checked })} />
                  Follow redirects
                </label>
                )}
                <label className="check">
                  <input type="checkbox" checked={active.insecure} onChange={(e) => patch({ insecure: e.target.checked })} />
                  Skip TLS certificate verification (self-signed)
                </label>
                <label className="check">
                  Timeout (ms)
                  <input
                    className="cell narrow"
                    type="number"
                    value={active.timeoutMs}
                    onChange={(e) => patch({ timeoutMs: Number(e.target.value) || 30000 })}
                  />
                </label>
              </div>
            )}
          </div>
        </section>

        <div className="splitter" onMouseDown={startDrag} role="separator" aria-orientation="horizontal" />

        {isStreamKind ? (
          <div className="stream-wrap" ref={resPanel as unknown as React.RefObject<HTMLDivElement>}>
            <StreamLog
              state={streamState}
              onClear={() => setStreams((m) => ({ ...m, [active.id]: { ...(m[active.id] ?? EMPTY_STREAM), entries: [], dropped: 0, sent: 0, received: 0 } }))}
              emptyHint={active.kind === "ws" ? "Connect, then send a message. Everything in both directions shows up here." : active.kind === "mcp" ? "Connect to a server. Every JSON-RPC message in both directions is logged here, plus the server's stderr for local commands." : active.kind === "grpc" ? "Pick a method and hit Invoke. Requests, responses, headers and the final status appear here." : "Connect to start receiving events."}
            />
          </div>
        ) : (
        <section className="panel res" ref={resPanel}>
          <nav className="subtabs">
            <button className={resSection === "body" ? "on" : ""} onClick={() => setResSection("body")}>
              Response
            </button>
            <button className={resSection === "headers" ? "on" : ""} onClick={() => setResSection("headers")}>
              Headers{response && !("error" in response) && <i>{response.headers.length}</i>}
            </button>
            {setCookies.length > 0 && (
              <button className={resSection === "cookies" ? "on" : ""} onClick={() => setResSection("cookies")}>
                Cookies<i>{setCookies.length}</i>
              </button>
            )}
            <button className={resSection === "tests" ? "on" : ""} onClick={() => setResSection("tests")}>
              Tests
              {run && run.tests.length > 0 && (
                <i className={run.tests.some((t) => !t.passed) ? "bad" : "good"}>
                  {run.tests.filter((t) => t.passed).length}/{run.tests.length}
                </i>
              )}
              {run?.scriptError && !run.tests.length && <i className="bad">!</i>}
            </button>
            {run && run.logs.length > 0 && (
              <button className={resSection === "console" ? "on" : ""} onClick={() => setResSection("console")}>
                Console<i>{run.logs.length}</i>
              </button>
            )}
            <div className="spacer" />
            {hist.length > 1 && (
              <>
                <select className="hist-pick" value={viewIdx ?? "latest"} title="Earlier responses to this request" onChange={(e) => setViewing((v) => ({ ...v, [active.id]: e.target.value === "latest" ? null : Number(e.target.value) }))}>
                  <option value="latest">Latest</option>
                  {hist.slice(0, -1).map((h, i) => (
                    <option key={h.n} value={i}>{new Date(h.at).toTimeString().slice(0, 8)} · {h.response.status} · {h.response.timeMs} ms</option>
                  )).reverse()}
                </select>
                <button className="btn small" onClick={() => setDiffOpen(true)} title="Compare two responses side by side">Compare</button>
              </>
            )}
            {response && !("error" in response) && (
              <div className="meta">
                <span className={`pill ${statusClass(response.status)}`}>
                  {response.status} {response.statusText}
                </span>
                <span title="Total time">{response.timeMs} ms</span>
                {response.ttfbMs !== undefined && <span className="muted" title="Time to first byte">TTFB {response.ttfbMs} ms</span>}
                <span>{formatBytes(response.sizeBytes)}</span>
                <span>{response.httpVersion}</span>
              </div>
            )}
          </nav>
          {viewIdx !== null && hist[viewIdx] && (
            <div className="view-banner">
              Showing an earlier response from {new Date(hist[viewIdx].at).toLocaleTimeString()}.
              <button className="link" onClick={() => setViewing((v) => ({ ...v, [active.id]: null }))}>Back to latest</button>
            </div>
          )}
          <div className={`panel-body ${resSection === "body" && response && !("error" in response) ? "fill" : ""}`}>
            {loading[active.id] && <p className="muted">Sending request…</p>}
            {!loading[active.id] && !response && active.url.trim() && <p className="muted center">Hit <kbd>⌘↵</kbd> to send a request.</p>}
            {response && "error" in response && resSection !== "tests" && resSection !== "console" && <pre className="err">{response.error}</pre>}
            {resSection === "tests" && run && (
              <div className="tests-list">
                {run.scriptError && <pre className="err">{run.scriptError}</pre>}
                {run.tests.length === 0 && !run.scriptError && <p className="muted">No tests ran. Add assertions in the Tests tab or <code>test()</code> calls in a script.</p>}
                {run.tests.map((t, i) => (
                  <div key={i} className={`test ${t.passed ? "pass" : "fail"}`}>
                    <span>{t.passed ? "✓" : "✗"}</span>
                    <div>
                      {t.name}
                      {t.error && <div className="run-err">{t.error}</div>}
                    </div>
                  </div>
                ))}
                {Object.keys(run.captured).length > 0 && (
                  <p className="muted small">Set variables: {Object.keys(run.captured).map((k) => `{{${k}}}`).join("  ")}</p>
                )}
              </div>
            )}
            {resSection === "tests" && !run && !loading[active.id] && <p className="muted">Send the request to see test results.</p>}
            {resSection === "console" && run && <pre className="code">{run.logs.join("\n")}</pre>}
            {response && !("error" in response) && resSection === "body" && resBody && (
              <>
                <div className="row tools">
                  {resBody.pretty && (
                    <label className="check">
                      <input type="checkbox" checked={rawView} onChange={(e) => setRawView(e.target.checked)} /> Raw
                    </label>
                  )}
                  <label className="check">
                    <input type="checkbox" checked={wrapRes} onChange={(e) => setWrapRes(e.target.checked)} /> Wrap
                  </label>
                  {!response.bodyBase64 && (
                    <button className="btn small" onClick={() => navigator.clipboard.writeText(resBody.pretty ?? resBody.text)}>
                      Copy
                    </button>
                  )}
                  <button
                    className="btn small"
                    onClick={() =>
                      guard(async () => {
                        const name = suggestFileName(active.url, response.headers, response.contentType ?? "");
                        const path = await saveResponse(name, { base64: response.bodyBase64, text: resBody.text });
                        if (path) flash(`Saved to ${path.split("/").pop()}`);
                      })
                    }
                  >
                    Save…
                  </button>
                  {(active.kind === "http" || active.kind === "graphql") && (
                    <button className="btn small" onClick={saveAsExample} title="Keep this response as a documented example; the mock server will serve it">
                      Save as example
                    </button>
                  )}
                </div>
                {response.bodyBase64 ? (
                  <div className="editor-slot scroll"><BinaryView base64={response.bodyBase64} contentType={response.contentType ?? ""} size={response.sizeBytes} /></div>
                ) : (
                <div className="editor-slot">
                  <CodeEditor
                    readOnly
                    wrap={wrapRes}
                    lang={resLang}
                    value={resBody.pretty && !rawView ? resBody.pretty : resBody.text}
                    vars={undefined}
                    className="fill"
                  />
                </div>
                )}
              </>
            )}
            {response && !("error" in response) && resSection === "cookies" && (
              <table className="htable">
                <tbody>
                  {setCookies.map((c, i) => (
                    <tr key={i}>
                      <td>{c.name}</td>
                      <td>
                        {c.value}
                        {c.attrs.length > 0 && <div className="muted small">{c.attrs.join(" · ")}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {response && !("error" in response) && resSection === "headers" && (
              <table className="htable">
                <tbody>
                  {response.headers.map(([k, v], i) => (
                    <tr key={i}>
                      <td>{k}</td>
                      <td>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
        )}
        </>
        )}
      </main>
      {mockOpen && collection && (
        <MockModal root={collection.root} name={collection.name} port={mockPort} log={mockLog} onStart={startMock} onStop={stopMock} onClearLog={() => setMockLog([])} onClose={() => setMockOpen(false)} />
      )}
      {diffOpen && hist.length > 1 && <DiffModal items={hist} onClose={() => setDiffOpen(false)} />}
      {codegenOpen && <CodeGenModal build={buildSnippet} onClose={() => setCodegenOpen(false)} />}
      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onChange={changeSettings}
          section={settingsOpen}
          onSection={setSettingsOpen}
          onClose={() => setSettingsOpen(null)}
          onClearHistory={() => { setHistory([]); flash("History cleared"); }}
          onClearSession={() => { sessionRef.current = {}; tokensRef.current = new Map(); bump(); flash("Session cleared"); }}
          onResetState={async () => {
            if (!(await confirmDialog("Reset app state", "Forgets open tabs, history, the last collection and all settings. Your collection files are not touched.", "Reset"))) return;
            Object.keys(localStorage).filter((k) => k.startsWith("rq.")).forEach((k) => localStorage.removeItem(k));
            location.reload();
          }}
        />
      )}
      <Dialog state={dialog} />
      {defaultsEdit && (
        <DefaultsModal
          title={defaultsEdit.title}
          initial={defaultsEdit.tab}
          onClose={() => setDefaultsEdit(null)}
          onSave={(t) =>
            guard(async () => {
              await saveDefaults(defaultsEdit.dir, t);
              setDefaultsEdit(null);
              setChainVer((v) => v + 1);
              flash("Defaults saved");
            })
          }
        />
      )}
      {runner && <RunnerModal run={runner} onStop={() => (stopRef.current = true)} onClose={() => setRunner(null)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
