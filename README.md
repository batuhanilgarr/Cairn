# Reqnest

Local-first API client for macOS. Built with Tauri 2 (Rust) + React + TypeScript.

No account, no cloud, no telemetry. Fast startup, tiny footprint.

## Status: v0.1 (early)

- HTTP client on a native Rust core (reqwest + rustls): all methods, headers, query params
- Bodies: JSON, text, form-urlencoded
- Auth: Bearer, Basic
- Environments with `{{variables}}`
- **Git-friendly collections**: a collection is a folder of plain YAML files (`*.req.yaml`), no generated IDs, stable key order, literal-block bodies for clean diffs. Order comes from file names, never from file contents
- Environments stored in `environments/*.env.yaml`; variables marked 🔒 secret live in `.reqnest/secrets.yaml` (auto-gitignored)
- Paste a `curl ...` command into the URL bar: method, headers, body, auth and Content-Type are filled in automatically
- **Import**: OpenAPI 3 / Swagger 2 (URL or file, JSON or YAML), Postman v2.x collections, Bruno collections (incl. environments)
- **OpenAPI re-sync**: re-importing updates requests in place (matched by `source: POST /pets`). The spec owns structure, you own values: new parameters and body fields are added, your values, URLs, headers and auth are kept, and operations removed from the spec are reported, never deleted
- **OAuth 2.0**: client credentials, authorization code (opens your default browser, PKCE, state check, loopback redirect on `127.0.0.1:<port>/callback`), password. Tokens are cached in memory, refreshed automatically, with Get new token / Reset. Extra token fields (audience, resource), client auth via header or body, custom header prefix. Variables work in every field
- **Tests without code**: assertions on status, JSON path, header, body, timing; **capture** response values into variables for the next request
- **Scripts**: pre-request and post-response JavaScript (`req`, `res`, `env`, `test`, `expect`) in an isolated Web Worker (no app or filesystem access, 5 s limit). Variables set by scripts/captures are session-only: kept in memory, never written to disk
- **Runner**: run a whole folder or collection in file order with live pass/fail
- **Folder & collection defaults** (⚙ on the collection or any folder, saved as `folder.yaml`): shared headers, auth and pre/post scripts. A folder overrides what's above it, a request overrides both; a request can switch an inherited header off, and new requests default to "Inherit auth". The request's Headers tab shows what it inherits and from where
- **Native macOS menu bar** (File, Edit, Request, View, Window, Help) with shortcuts, and a **Settings** window (⌘,): defaults, appearance (theme, accent, zoom), network (proxy, custom CA, client certificates for mutual TLS, user agent), shortcuts, data
- **GraphQL**: query + variables editors, schema fetched by introspection (using the request's own auth/headers/scripts) for autocomplete, inline validation and a searchable docs browser
- **WebSocket**: connect with headers/auth/subprotocols (custom CA and client certs supported), send text, JSON or binary (base64), saved messages, a filterable live message log
- **Server-Sent Events** (GET or POST, e.g. LLM streaming APIs): live event log with event names, ids, retry; non-SSE streams (NDJSON) show as raw chunks
- **gRPC**: schema from server reflection or your `.proto` files (compiled in-process, import paths supported), method picker with JSON templates, unary, server/client/bidirectional streaming, metadata, deadlines, TLS with custom CA / client certs / skip-verify, final status code and trailers. int64 values keep full precision
- **Binary responses** (images, audio, video, PDF previews; hex dump for the rest), Save to file, time-to-first-byte
- **Code generation** in 14 languages (⇧⌘G), variables resolved or kept as `{{name}}`
- **Cookie jar**: stored on this Mac, sent automatically, viewable and editable in Settings > Cookies; per-response Set-Cookie tab
- **Response history & diff**: the last 20 responses per request, side-by-side body/header comparison (free, unlike some alternatives)
- **CLI for CI** (`cli/`): `reqnest run ./collection --env Staging --junit results.xml`: the same pipeline as the app (inheritance, captures, scripts, assertions, OAuth, cookies), data-driven runs, JUnit/JSON/HTML reports, a GitHub Action. See [cli/README.md](cli/README.md)
- **Response examples & mock server**: save any response as an example (stored in the request file); imported OpenAPI specs get examples built from their schemas, kept across re-syncs. One click serves the collection locally with path params, `{{params.id}}` / `{{query.x}}` / `{{$uuid}}` templating, delays, CORS, picking an example per call (`X-Mock-Example`, `X-Mock-Status`) and a live request log
- **Command palette** (⌘K): jump to any request, tab or environment, run actions
- **Auto-save** (optional) writes request edits to disk as you type
- Draggable split between request and response
- Edits made outside the app (git pull, editor) are picked up when the window regains focus
- Tabs, request history, JSON highlighting, response headers/size/time
- Per-request: redirects, TLS verification toggle, timeout
- `⌘↵` send, `⌘S` save, `⌘T` new tab, `⌘W` close tab

## Roadmap

MCP support, optional self-hostable team sync, Windows and Linux builds, collection docs export.

## Develop

Requires Node 20+ and Rust (rustup).

```bash
npm install
npm run tauri dev      # run the app
npm run tauri build    # produce a .app / .dmg (the .app is about 10 MB)
npm run build --prefix cli   # the CI runner: see cli/README.md
```
