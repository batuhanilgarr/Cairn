import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { KVEditor } from "./KVEditor";
import { Dialog, type DialogState } from "./Dialog";
import { Tree } from "./Tree";
import {
  basename,
  dirname,
  listFilesRecursive,
  listTree,
  makeDir,
  pickFile,
  pickFolder,
  readText,
  removePath,
  renamePath,
  writeText,
} from "./lib/fs";
import {
  initCollection,
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
import type { AuthMode, BodyMode, Collection, Environment, HistoryItem, RequestTab, ResponseData, TreeNode } from "./lib/types";
import {
  METHODS,
  buildRequest,
  emptyKV,
  formatBytes,
  highlightJson,
  load,
  newTab,
  save,
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

type ReqSection = "params" | "headers" | "body" | "auth" | "settings";
type ResSection = "body" | "headers";
type SideSection = "collections" | "history" | "environments";

const defaultEnvs: Environment[] = [
  { id: "env-local", name: "Local", vars: [emptyKV()] },
];

export default function App() {
  const [tabs, setTabs] = useState<RequestTab[]>(() => {
    const t = load<RequestTab[]>("rq.tabs", []);
    return t.length ? t : [newTab()];
  });
  const [activeId, setActiveId] = useState<string>(() => load("rq.active", "") || "");
  const [envs, setEnvs] = useState<Environment[]>(() => load("rq.envs", defaultEnvs));
  const [envId, setEnvId] = useState<string>(() => load("rq.envId", "env-local"));
  const [history, setHistory] = useState<HistoryItem[]>(() => load("rq.history", []));
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
  const [rawView, setRawView] = useState(false);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const env = envs.find((e) => e.id === envId);
  const response = active ? responses[active.id] : null;

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
  useEffect(() => save("rq.history", history.slice(0, 100)), [history]);

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
  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 1800);
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
    const res = await invoke<ResponseData>("send_request", {
      spec: { method: "GET", url, headers: [["Accept", "application/json, application/yaml, text/yaml, */*"]], body: null, timeoutMs: 30000, insecure: false, followRedirects: true },
    });
    if (res.status >= 400) throw new Error(`Fetching the spec failed: HTTP ${res.status} ${res.statusText}`);
    return res.body;
  };

  const importOpenApi = async (source: string, sync: boolean) => {
    if (!collection) return;
    const text = /^https?:\/\//i.test(source) ? await fetchSpec(source) : await readText(source);
    if (text === null) throw new Error(`Couldn't read ${source}`);
    const parsed = parseOpenApi(text);
    const summary = await writeImport(collection.root, parsed.requests, sync);
    const env = await ensureEnvironment(collection.root, parsed.title, parsed.vars);
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
      const tab = { ...newTab(), name };
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
      const ok = await confirmDialog(
        node.isDir ? "Delete folder" : "Delete request",
        node.isDir ? `"${node.name}" and everything inside it will be deleted from disk.` : `"${node.name}" will be deleted from disk.`,
      );
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
      await refreshTree();
      const current = tabsRef.current;
      for (const t of current) {
        if (!t.file || t.saved == null || serializeRequest(t) !== t.saved) continue;
        const text = await readText(t.file).catch(() => null);
        if (text !== null && text !== t.saved) {
          const fresh = parseRequest(text, t.file);
          setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...fresh, id: t.id } : x)));
        }
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

  const addTab = (t?: RequestTab) => {
    const tab = t ?? newTab();
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  };

  const closeTab = (id: string) => {
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

  const send = useCallback(async () => {
    if (!active || !active.url.trim()) return;
    const tab = active;
    setLoading((l) => ({ ...l, [tab.id]: true }));
    setResponses((r) => ({ ...r, [tab.id]: null }));
    let status: number | null = null;
    try {
      const res = await invoke<ResponseData>("send_request", { spec: buildRequest(tab, env) });
      status = res.status;
      setResponses((r) => ({ ...r, [tab.id]: res }));
    } catch (e) {
      setResponses((r) => ({ ...r, [tab.id]: { error: String(e) } }));
    } finally {
      setLoading((l) => ({ ...l, [tab.id]: false }));
      setHistory((h) =>
        [{ id: uid(), at: Date.now(), method: tab.method, url: tab.url, status, tab }, ...h].slice(0, 100),
      );
    }
  }, [active, env]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        send();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveTab(active);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "t") {
        e.preventDefault();
        addTab();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        closeTab(active.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const isDirty = (t: RequestTab) => !!t.file && t.saved != null && serializeRequest(t) !== t.saved;
  const dirtyFiles = useMemo(() => new Set(tabs.filter(isDirty).map((t) => t.file!)), [tabs]);
  const tabTitle = (t: RequestTab) => t.name !== "New request" ? t.name : t.url.replace(/^https?:\/\//, "") || "New request";

  const counts = useMemo(
    () => ({
      params: active?.params.filter((p) => p.enabled && p.key).length ?? 0,
      headers: active?.headers.filter((p) => p.enabled && p.key).length ?? 0,
    }),
    [active],
  );

  const resBody = useMemo(() => {
    if (!response || "error" in response) return null;
    const pretty = tryPrettyJson(response.body);
    return { pretty, text: response.body };
  }, [response]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="titlebar-drag" data-tauri-drag-region />
        <div className="brand">
          <span className="logo">◆</span> Reqnest
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
                  <span className={`m m-${h.method}`}>{h.method}</span>
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
                      if (!(await confirmDialog("Delete environment", `"${env.name}" will be removed.`))) return;
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
      </aside>

      <main className="main">
        <div className="tabbar" data-tauri-drag-region>
          {tabs.map((t) => (
            <div key={t.id} className={`tab ${t.id === active.id ? "on" : ""}`} onClick={() => setActiveId(t.id)}>
              <span className={`m m-${t.method}`}>{t.method}</span>
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
          <select className={`method m-${active.method}`} value={active.method} onChange={(e) => patch({ method: e.target.value })}>
            {METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <input
            className="url"
            placeholder="Enter URL, e.g. https://api.example.com/users  (use {{vars}})"
            value={active.url}
            spellCheck={false}
            onPaste={(e) => {
              // Intercept before the <input> flattens multi-line text.
              const text = e.clipboardData.getData("text");
              if (looksLikeCurl(text)) {
                e.preventDefault();
                applyCurl(text);
              }
            }}
            onChange={(e) => (looksLikeCurl(e.target.value) ? applyCurl(e.target.value) : patch({ url: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <button className="btn primary" onClick={send} disabled={loading[active.id]}>
            {loading[active.id] ? "Sending…" : "Send"}
            <kbd>⌘↵</kbd>
          </button>
        </div>

        <section className="panel req">
          <nav className="subtabs">
            {(["params", "headers", "body", "auth", "settings"] as ReqSection[]).map((s) => (
              <button key={s} className={reqSection === s ? "on" : ""} onClick={() => setReqSection(s)}>
                {s[0].toUpperCase() + s.slice(1)}
                {s === "params" && counts.params > 0 && <i>{counts.params}</i>}
                {s === "headers" && counts.headers > 0 && <i>{counts.headers}</i>}
              </button>
            ))}
          </nav>
          <div className="panel-body">
            {reqSection === "params" && <KVEditor rows={active.params} onChange={(params) => patch({ params })} />}
            {reqSection === "headers" && <KVEditor rows={active.headers} onChange={(headers) => patch({ headers })} />}
            {reqSection === "body" && (
              <div className="col">
                <div className="row">
                  {(["none", "json", "text", "form"] as BodyMode[]).map((m) => (
                    <label key={m} className="radio">
                      <input type="radio" checked={active.bodyMode === m} onChange={() => patch({ bodyMode: m })} />
                      {m === "form" ? "form-urlencoded" : m}
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
                ) : (
                  <textarea
                    className="editor"
                    spellCheck={false}
                    value={active.body}
                    placeholder={active.bodyMode === "form" ? "key=value&other=value" : active.bodyMode === "json" ? '{ "hello": "world" }' : ""}
                    onChange={(e) => patch({ body: e.target.value })}
                  />
                )}
              </div>
            )}
            {reqSection === "auth" && (
              <div className="col">
                <select value={active.authMode} onChange={(e) => patch({ authMode: e.target.value as AuthMode })}>
                  <option value="none">No auth</option>
                  <option value="bearer">Bearer token</option>
                  <option value="basic">Basic auth</option>
                </select>
                {active.authMode === "bearer" && (
                  <input className="cell" placeholder="Token" value={active.authToken} onChange={(e) => patch({ authToken: e.target.value })} />
                )}
                {active.authMode === "basic" && (
                  <>
                    <input className="cell" placeholder="Username" value={active.authUser} onChange={(e) => patch({ authUser: e.target.value })} />
                    <input className="cell" type="password" placeholder="Password" value={active.authPass} onChange={(e) => patch({ authPass: e.target.value })} />
                  </>
                )}
              </div>
            )}
            {reqSection === "settings" && (
              <div className="col">
                <label className="check">
                  <input type="checkbox" checked={active.followRedirects} onChange={(e) => patch({ followRedirects: e.target.checked })} />
                  Follow redirects
                </label>
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

        <section className="panel res">
          <nav className="subtabs">
            <button className={resSection === "body" ? "on" : ""} onClick={() => setResSection("body")}>
              Response
            </button>
            <button className={resSection === "headers" ? "on" : ""} onClick={() => setResSection("headers")}>
              Headers{response && !("error" in response) && <i>{response.headers.length}</i>}
            </button>
            <div className="spacer" />
            {response && !("error" in response) && (
              <div className="meta">
                <span className={`pill ${statusClass(response.status)}`}>
                  {response.status} {response.statusText}
                </span>
                <span>{response.timeMs} ms</span>
                <span>{formatBytes(response.sizeBytes)}</span>
                <span>{response.httpVersion}</span>
              </div>
            )}
          </nav>
          <div className="panel-body">
            {loading[active.id] && <p className="muted">Sending request…</p>}
            {!loading[active.id] && !response && <p className="muted center">Hit <kbd>⌘↵</kbd> to send a request.</p>}
            {response && "error" in response && <pre className="err">{response.error}</pre>}
            {response && !("error" in response) && resSection === "body" && resBody && (
              <>
                <div className="row tools">
                  {resBody.pretty && (
                    <label className="check">
                      <input type="checkbox" checked={rawView} onChange={(e) => setRawView(e.target.checked)} /> Raw
                    </label>
                  )}
                  <button className="btn small" onClick={() => navigator.clipboard.writeText(resBody.pretty ?? resBody.text)}>
                    Copy
                  </button>
                </div>
                {resBody.pretty && !rawView ? (
                  <pre className="code" dangerouslySetInnerHTML={{ __html: highlightJson(resBody.pretty) }} />
                ) : (
                  <pre className="code">{resBody.text}</pre>
                )}
              </>
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
      </main>
      <Dialog state={dialog} />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
