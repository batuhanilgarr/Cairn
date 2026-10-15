# Cairn

Local-first API client for macOS. Built with Tauri 2 (Rust) + React + TypeScript.

No account, no cloud, no telemetry. Fast startup, tiny footprint.

## Status: v0.2 (early)

- HTTP client on a native Rust core (reqwest + rustls): all methods, headers, query params
- Bodies: JSON, text, form-urlencoded, **multipart/form-data** (text and file fields, per-field Content-Type) and raw **binary file**; `curl -F` is imported, and the CLI sends them too
- Auth: Bearer, Basic
- Environments with `{{variables}}`, plus built-in **dynamic variables** that are generated fresh on every use: `{{$guid}}` / `{{$uuid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$date}}`, `{{$randomInt}}`, `{{$randomString}}`, `{{$randomEmail}}`, `{{$randomBoolean}}` (autocomplete and hover included; a variable of the same name in an environment wins)
- **Git-friendly collections**: a collection is a folder of plain YAML files (`*.req.yaml`), no generated IDs, stable key order, literal-block bodies for clean diffs. Order comes from file names, never from file contents
- Environments stored in `environments/*.env.yaml`; variables marked 🔒 secret live in `.cairn/secrets.yaml` (auto-gitignored)
- **Variable scopes**, lowest to highest: global (Settings > Variables, this Mac only) < collection < folder (⚙ > Variables, saved in `folder.yaml`, so they are committed and the CLI sees them) < environment < values set by scripts/captures. A deeper folder overrides a shallower one
- **Params ⇄ URL stay in sync**, like Postman: type `?a=1&b=2` and the Params table fills in (decoded); edit or switch off a row and only that part of the URL changes (your original encoding and `{{variables}}` are kept). Request files keep the whole query in `url` and only the switched-off rows in `params` into the URL bar: method, headers, body, auth and Content-Type are filled in automatically
- **Import**: OpenAPI 3 / Swagger 2 (URL, file or straight from the clipboard with a preview, JSON or YAML), Bruno collections (incl. environments), **SOAP/WSDL** (every operation becomes a POST with a sample envelope built from the schema), **HAR recordings** from a browser's Network tab (API calls only by default; Authorization, cookies, keys and passwords never reach the files, they become secret variables), and **Postman** in bulk: point at the folder of your exports (Settings > Data > Export Data in Postman) and every collection, environment and the globals come over. Each collection gets its own folder; collection/folder-level auth, variables and scripts become `folder.yaml`; OAuth 2.0, API key, bearer and basic auth, form-data/file/GraphQL bodies, saved example responses and pre-request/test scripts are carried. Literal passwords, tokens and secrets are moved out of the files into global variables so they are never committed; secret environment values stay in the git-ignored secrets file, or in the macOS Keychain if you choose that in Settings > Secrets
- **OpenAPI re-sync**: re-importing updates requests in place (matched by `source: POST /pets`). The spec owns structure, you own values: new parameters and body fields are added, your values, URLs, headers and auth are kept, and operations removed from the spec are reported, never deleted
- **OAuth 2.0**: client credentials, authorization code (opens your default browser, PKCE, state check, loopback redirect on `127.0.0.1:<port>/callback`), password. Tokens are cached in memory, refreshed automatically, with Get new token / Reset. Extra token fields (audience, resource), client auth via header or body, custom header prefix. Variables work in every field
- **Tests without code**: assertions on status, JSON path, header, body, timing; **capture** response values into variables for the next request
- **Scripts**: pre-request and post-response JavaScript (`req`, `res`, `env`, `test`, `expect`), and **Postman scripts run as they are**: `pm.test`, Chai-style `pm.expect`, `pm.environment` / `pm.variables`, `pm.request`, `pm.response`, legacy `tests[...]` and `postman.*` in an isolated Web Worker (no app or filesystem access, 5 s limit). Variables set by scripts/captures are session-only: kept in memory, never written to disk
- **Runner**: run a whole folder or collection in file order with live pass/fail
- **Folder & collection defaults** (⚙ on the collection or any folder, saved as `folder.yaml`): shared headers, auth and pre/post scripts. A folder overrides what's above it, a request overrides both; a request can switch an inherited header off, and new requests default to "Inherit auth". The request's Headers tab shows what it inherits and from where
- **Native macOS menu bar** (File, Edit, Request, View, Window, Help) with shortcuts, and a **Settings** window (⌘,): defaults, appearance (theme, accent, zoom), network (proxy, custom CA, client certificates for mutual TLS, user agent), shortcuts, data
- **GraphQL**: query + variables editors, schema fetched by introspection (using the request's own auth/headers/scripts) for autocomplete, inline validation and a searchable docs browser
- **WebSocket**: connect with headers/auth/subprotocols (custom CA and client certs supported), send text, JSON or binary (base64), saved messages, a filterable live message log
- **Socket.IO** (v4 servers, WebSocket transport): namespaces, an auth payload, emit events with JSON arguments, ask for acknowledgements and see them matched to the event, every server event in the live log, saved events. Tested against the real `socket.io` server. Not yet: long-polling-only servers, binary attachments (listed, not decoded), Socket.IO v2
- **Server-Sent Events** (GET or POST, e.g. LLM streaming APIs): live event log with event names, ids, retry; non-SSE streams (NDJSON) show as raw chunks
- **gRPC**: schema from server reflection or your `.proto` files (compiled in-process, import paths supported), method picker with JSON templates, unary, server/client/bidirectional streaming, metadata, deadlines, TLS with custom CA / client certs / skip-verify, final status code and trailers. int64 values keep full precision
- **Binary responses** (images, audio, video, PDF previews; hex dump for the rest), Save to file, time-to-first-byte
- **Code generation** in 14 languages (⇧⌘G), variables resolved or kept as `{{name}}`
- **Cookie jar**: stored on this Mac, sent automatically, viewable and editable in Settings > Cookies; per-response Set-Cookie tab
- **Big responses and filtering**: bodies of 8 MB and more stay on the Rust side and are drawn as a virtual list, so 50 and 100 MB responses open without freezing and search at any size. A filter row (jq subset or JSONPath) narrows a JSON response of any size; on big ones it runs where the body lives (50 MB, 467k rows: about 0.4 s)
- **Response history & diff**: the last 20 responses per request, side-by-side body/header comparison (free, unlike some alternatives)
- **CLI for CI** (`cli/`): `cairn run ./collection --env Staging --junit results.xml`: the same pipeline as the app (inheritance, captures, scripts, assertions, OAuth, cookies), data-driven runs, JUnit/JSON/HTML reports, a GitHub Action, `cairn bench` for load tests with p50/p95/p99 and CI limits, and `cairn scan` to catch credentials before you commit them. The file format is documented and has a published JSON Schema ([docs/file-format.md](docs/file-format.md)), and `cairn validate` checks your files against it. See [cli/README.md](cli/README.md)
- **Response examples & mock server**: save any response as an example (stored in the request file); imported OpenAPI specs get examples built from their schemas, kept across re-syncs. One click serves the collection locally with path params, `{{params.id}}` / `{{query.x}}` / `{{$uuid}}` templating, delays, CORS, picking an example per call (`X-Mock-Example`, `X-Mock-Status`) and a live request log
- **MCP client**: connect to Model Context Protocol servers over Streamable HTTP or a local stdio command, browse tools / resources / prompts, call them with schema-based argument templates, send raw JSON-RPC, and watch the full wire log (including server stderr)
- **AI assistant** (⇧⌘A, right panel): ask questions about the request you have open, using your own model. Works with **Ollama** (its native `/api/chat`, model list from `/api/tags`) and any **OpenAI-compatible** server; auth is optional (no token, no header) and you can fill the settings by pasting the curl you already use. The model sees the method, URL, headers and body (and optionally the last response) with credentials hidden and `{{variables}}` left unresolved, and Settings > AI shows exactly what is sent. Calls go through the app's own HTTP layer, so proxy/CA settings apply: jump to any request, tab or environment, run actions
- **Auto-save** (optional) writes request edits to disk as you type
- Draggable split between request and response
- Edits made outside the app (git pull, editor) are picked up when the window regains focus
- Tabs (preview tab, drag to reorder, reopen closed, **split view** with two requests side by side: ⌘\\), request history, JSON highlighting, response headers/size/time
- Per-request: redirects, TLS verification toggle, timeout
- `⌘↵` send, `⌘S` save, `⌘T` new tab, `⌘W` close tab

## Roadmap

Optional self-hostable team sync, Windows and Linux builds, collection docs export.

## Develop

Requires Node 20+ and Rust (rustup).

```bash
npm install
npm run tauri dev      # run the app
npm run tauri build    # produce a .app / .dmg (the .app is about 10 MB)
npm run build --prefix cli   # the CI runner: see cli/README.md
npm run test:ui        # layout checks in real Chrome: many sizes, light/dark, panels open/closed (also runs in CI)
npm run test:site      # website checks in real Chrome: SEO tags, JSON-LD, links, headings, overflow at 320-1280 px, axe (WCAG A/AA) in light and dark, 404 behaviour; writes screenshots to test-results/site
npm run site:serve     # preview website/ on http://127.0.0.1:4350 the way GitHub Pages serves it (unknown paths give 404.html)
node scripts/set-site-url.mjs https://your.domain/   # move the site to a new address (see the header of that script)
npm run test:openapi   # exports a fixture collection and validates the result with Redocly (needs network; runs in CI)
npm run bench:ui       # rendering benchmark: 10,000-request collection, 5 and 50 MB responses
```
