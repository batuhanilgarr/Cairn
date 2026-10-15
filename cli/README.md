# Cairn CLI

Run a Cairn collection in CI with exactly the logic the app uses: folder and collection defaults, variable
captures, pre/post scripts, assertions, OAuth client credentials, cookies, redirects.

```bash
npx cairn run ./my-collection --env Staging --junit results.xml
```

(Until it's on npm: `cd cli && npm ci && npm run build`, then `node dist/cairn.mjs run …`.)

| Option | |
|---|---|
| `-e, --env <name[,name]>` | environment (by name or file name); a comma list layers them, later ones win. An environment file with `extends: Base` also gets Base's variables. Defaults to the only one |
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
- uses: batuhanilgarr/Cairn@main
  with:
    path: api-tests
    env: Staging
    junit: results.xml
  env:
    CAIRN_VAR_clientSecret: ${{ secrets.CLIENT_SECRET }}
```

## Scan for secrets

```sh
npx cairn scan ./my-collection            # exit code 1 if something at "medium" or above is found
npx cairn scan . --fail-on high           # only fail on known token formats, private keys, passwords in URLs
npx cairn scan . --format json
```

It reads the YAML files you commit (requests, folder defaults, environments) and reports credentials written into them: known token formats (GitHub, AWS, Stripe, Google, Slack, OpenAI/Anthropic-style keys, JWTs, private keys), literal values under names like `password`, `token`, `apiKey`, `Authorization`, secrets in a URL, and a repository whose `.gitignore` is missing `.cairn/`. Output shows a masked preview only. Silence a line with a `# cairn-ignore` comment. Use it as a pre-commit hook or a CI step. Values already committed in Git history are not searched: rotate them.

## Export OpenAPI

```sh
npx cairn export openapi ./my-collection -o api.yaml      # or api.json
npx cairn export openapi ./my-collection --env Prod        # use Prod's baseUrl as the server
npx cairn export openapi ./my-collection/invoices          # just one folder
```

Requests become operations, folders become tags, saved examples become responses, and auth settings (including what folders inherit) become security schemes. `{{baseUrl}}` becomes the server (or a server variable when no value is known). gRPC, WebSocket, SSE and MCP requests can't be described in OpenAPI and are skipped with a note. Credentials are never written: auth values are left out and sensitive fields in examples are replaced by `<redacted>`.

## Validate the files

```sh
npx cairn validate ./my-collection
```

Checks requests, folder defaults, the collection file and environments against the published JSON Schemas (format v1) and prints `file:line  path  message`. Exit code 1 if anything is wrong, so it works as a pre-commit hook or a CI step. The same schemas give VS Code completion and hover docs: see [docs/file-format.md](../docs/file-format.md).

## Import a browser recording (HAR)

```sh
npx cairn import har recording.har ./my-collection            # API calls only
npx cairn import har recording.har ./my-collection --all       # pages, scripts, images too
npx cairn import har recording.har . --name checkout --dry-run # see what would be imported, write nothing
```

Save the recording in your browser (DevTools > Network > Save all as HAR) and import it into a collection folder (or any folder inside one). Each recording gets its own folder and an environment with `{{baseUrl}}`. Tokens, passwords, API keys and `Authorization` headers are moved into secret variables (kept in the git-ignored `.cairn/secrets.yaml`) instead of the request files, cookies are dropped, and the command never prints a credential. Importing the same recording twice creates a second copy; use `--name` to keep them apart.
