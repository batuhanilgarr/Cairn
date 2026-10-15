export type KV = { id: string; key: string; value: string; enabled: boolean; secret?: boolean };
export type BodyMode = "none" | "json" | "text" | "form" | "multipart" | "binary";
/** One field of a multipart/form-data body. For `file` parts, `value` is the absolute path of the file to upload. */
export type FormPart = { id: string; key: string; value: string; enabled: boolean; kind: "text" | "file"; contentType?: string };
/** "inherit" uses the nearest folder/collection auth (see lib/inherit.ts). */
export type AuthMode = "none" | "inherit" | "bearer" | "basic" | "oauth2";

export type OAuthGrant = "client_credentials" | "authorization_code" | "password";
export type OAuthConfig = {
  grant: OAuthGrant;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  /** Loopback port the system-browser redirect comes back to (http://127.0.0.1:<port>/callback). */
  redirectPort: number;
  pkce: boolean;
  /** Where the client credentials go on the token request. */
  clientAuth: "basic" | "body";
  username: string;
  password: string;
  /** Extra token-request fields, e.g. audience, resource. */
  extra: KV[];
  /** Authorization header prefix. */
  prefix: string;
};

export type AssertKind = "status" | "json" | "header" | "body" | "time";
export type AssertOp = "eq" | "neq" | "contains" | "matches" | "exists" | "lt" | "gt";
export type Assertion = { id: string; enabled: boolean; kind: AssertKind; path: string; op: AssertOp; value: string };
export type Capture = { id: string; variable: string; from: "json" | "header"; path: string };
export type TestResult = { name: string; passed: boolean; error?: string };
export type RunOutput = { tests: TestResult[]; logs: string[]; scriptError?: string; captured: Record<string, string> };

/** A saved response. Examples document the API and are what the mock server answers with. */
export type ResponseExample = { id: string; name: string; status: number; headers: KV[]; body: string; delayMs: number };

export type RequestKind = "http" | "graphql" | "sse" | "ws" | "grpc" | "mcp";

export type McpConfig = { transport: "http" | "stdio"; command: string; args: string; env: KV[] };

export type GraphQLConfig = { query: string; variables: string; operation: string };
export type SavedMessage = { id: string; name: string; body: string };
export type WsConfig = { composer: string; messages: SavedMessage[]; protocols: string };
export type GrpcConfig = {
  /** "reflection" asks the server for its schema; "proto" uses the .proto files below. */
  source: "reflection" | "proto";
  protoFiles: string[];
  importPaths: string[];
  /** Fully-qualified method: "pkg.Service/Method" */
  method: string;
  message: string;
  tls: boolean;
};

export type RequestTab = {
  /** Set when this file is a link (`use:`) to a shared request: the absolute path of the file that holds the real content. */
  linkTo?: string;
  /** A tab opened by a single click in the tree: the next single click replaces it, unless you edit or keep it. */
  preview?: boolean;
  kind: RequestKind;
  examples: ResponseExample[];
  gql: GraphQLConfig;
  ws: WsConfig;
  grpc: GrpcConfig;
  mcp: McpConfig;
  id: string;
  name: string;
  method: string;
  url: string;
  params: KV[];
  headers: KV[];
  bodyMode: BodyMode;
  /** Text/JSON body, or for `binary` the absolute path of the file to send. */
  body: string;
  formParts: FormPart[];
  /** Variables set by a folder or the collection (folder.yaml). Only used on defaults objects, never on requests. */
  vars?: KV[];
  authMode: AuthMode;
  authToken: string;
  authUser: string;
  authPass: string;
  insecure: boolean;
  followRedirects: boolean;
  timeoutMs: number;
  preScript: string;
  postScript: string;
  assertions: Assertion[];
  captures: Capture[];
  oauth: OAuthConfig;
  /** Origin of an imported request, e.g. "POST /pets" for OpenAPI. Lets re-import match it up again. */
  source?: string;
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
  /** Present instead of `body` for binary responses. */
  bodyBase64?: string | null;
  /** Set instead of `body` for big text responses, which stay in Rust (see lib/bigbody.ts). */
  bodyId?: number | null;
  contentType?: string;
  sizeBytes: number;
  timeMs: number;
  ttfbMs?: number;
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

export type Environment = {
  id: string;
  name: string;
  vars: KV[];
  file?: string;
  /** Name of an environment this one builds on: its variables apply first, this one overrides them. */
  extends?: string;
  /** Secret variables whose value is in the Keychain but couldn't be read here (CLI, or access denied). */
  missing?: string[];
};

export type TreeNode = { name: string; path: string; isDir: boolean; children: TreeNode[] };
export type Collection = { root: string; name: string };
