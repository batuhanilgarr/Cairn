export type KV = { id: string; key: string; value: string; enabled: boolean; secret?: boolean };
export type BodyMode = "none" | "json" | "text" | "form";
export type AuthMode = "none" | "bearer" | "basic";

export type RequestTab = {
  id: string;
  name: string;
  method: string;
  url: string;
  params: KV[];
  headers: KV[];
  bodyMode: BodyMode;
  body: string;
  authMode: AuthMode;
  authToken: string;
  authUser: string;
  authPass: string;
  insecure: boolean;
  followRedirects: boolean;
  timeoutMs: number;
  /** Absolute path of the .req.yaml this tab is bound to (null = unsaved scratch request). */
  file?: string | null;
  /** Serialized form last written to / read from disk, used to detect unsaved changes. */
  saved?: string | null;
};

export type ResponseData = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  sizeBytes: number;
  timeMs: number;
  httpVersion: string;
};

export type HistoryItem = {
  id: string;
  at: number;
  method: string;
  url: string;
  status: number | null;
  tab: RequestTab;
};

export type Environment = { id: string; name: string; vars: KV[]; file?: string };

export type TreeNode = { name: string; path: string; isDir: boolean; children: TreeNode[] };
export type Collection = { root: string; name: string };
