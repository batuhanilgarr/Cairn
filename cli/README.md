# Cairn CLI

Run a Cairn collection in CI with exactly the logic the app uses: folder and collection defaults, variable
captures, pre/post scripts, assertions, OAuth client credentials, cookies, redirects.

```bash
npx cairn run ./my-collection --env Staging --junit results.xml
```

(Until it's on npm: `cd cli && npm ci && npm run build`, then `node dist/cairn.mjs run …`.)

| Option | |
|---|---|
| `-e, --env <name>` | environment (by name or file name); defaults to the only one |
| `--var key=value` | set a variable, repeatable. Also `CAIRN_VAR_<name>` environment variables, handy for CI secrets |
| `-d, --data file.csv\|json` | run once per row; columns become variables |
| `-n, --iterations <n>` | repeat the run |
| `--bail` | stop at the first failure |
| `--delay <ms>` / `--timeout <ms>` | pacing, per-request timeout |
| `-k, --insecure` / `--ca <pem>` / `--proxy <url>` / `--no-cookies` | network |
| `--junit <file>` / `--json <file>` / `--html <file>` | reports |

Exit code: `0` all passed, `1` a test or request failed, `2` bad usage or configuration.

**Secrets.** 🔒 secret variables live in `.cairn/secrets.yaml`, which is git-ignored, so on CI they're empty. Supply them as
`CAIRN_VAR_clientSecret=…` (or `--var`).

**Not in the CLI:** browser sign-in (OAuth authorization code), WebSocket, SSE and gRPC requests are skipped. Scripts run in a
Node worker thread: unlike the app they are not sandboxed, so treat them like any other code in your CI.

### GitHub Actions

```yaml
- uses: batuhanilgarr/Reqnest@main
  with:
    path: api-tests
    env: Staging
    junit: results.xml
  env:
    CAIRN_VAR_clientSecret: ${{ secrets.CLIENT_SECRET }}
```
