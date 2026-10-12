# Reqnest

Local-first API client for macOS. Built with Tauri 2 (Rust) + React + TypeScript.

No account, no cloud, no telemetry. Fast startup, tiny footprint.

## Status: v0.1 (early)

- HTTP client on a native Rust core (reqwest + rustls): all methods, headers, query params
- Bodies: JSON, text, form-urlencoded
- Auth: Bearer, Basic
- Environments with `{{variables}}`
- Tabs, request history, JSON highlighting, response headers/size/time
- Per-request: redirects, TLS verification toggle, timeout
- `⌘↵` send, `⌘T` new tab, `⌘W` close tab

## Roadmap

OpenAPI import/sync, OAuth2, file-based Git-friendly collections, scripts and assertions, CLI runner,
gRPC / WebSocket / SSE / GraphQL, mock server, MCP support, team sync (self-hostable).

## Develop

Requires Node 20+ and Rust (rustup).

```bash
npm install
npm run tauri dev      # run the app
npm run tauri build    # produce a .app / .dmg
```
