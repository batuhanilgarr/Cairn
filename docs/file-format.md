# Cairn file format (v1)

A Cairn collection is a folder of plain YAML files. Nothing is generated, nothing is hidden in a database, and the files are written so that a change in the app is a small change in `git diff`:

- no generated ids and no sequence numbers: order comes from file names
- keys are always written in the same order, and values that equal the default are left out
- multi-line values (bodies, scripts) are YAML literal blocks, so a changed line is one changed line in the diff

This page is the contract for the format. The machine-readable version is a set of [JSON Schemas](https://json-schema.org/) (draft 2020-12), published with the website and versioned in the URL:

| File | Schema |
|---|---|
| `*.req.yaml` — one request | [request.schema.json](../website/schema/v1/request.schema.json) |
| `folder.yaml` — defaults for a folder (and the collection root) | [folder.schema.json](../website/schema/v1/folder.schema.json) |
| `cairn.yaml` — marks the collection root | [collection.schema.json](../website/schema/v1/collection.schema.json) |
| `environments/*.env.yaml` — a set of variables | [environment.schema.json](../website/schema/v1/environment.schema.json) |

Published at `https://batuhanilgarr.github.io/Reqnest/schema/v1/<name>.schema.json` (the host will move when the project gets its own domain; the `/schema/v1/` path stays).

## Stability

Within v1, keys are only ever **added** (optional, with a default), never removed, renamed or given a different meaning. A file that is valid today stays valid. A change that would break this ships as `/schema/v2/` together with a migration, and the app keeps reading v1 files. Collections made before the rename to Cairn have `reqnest.yaml` and `.reqnest/`: both are still read.

Because the schemas list every known key (`additionalProperties: false`), a typo such as `valeu:` is flagged in your editor and by `cairn validate`. A file written by a *newer* Cairn can contain a key an older schema doesn't know yet: update the schema from the URL above.

## Check your files

```sh
npx cairn validate ./my-collection
```

prints `file:line  path  what is wrong` for every problem and exits 1 if there is any, so it works in CI and as a pre-commit hook. Only collection files are checked (`*.req.yaml`, `folder.yaml`, the root `cairn.yaml`, `environments/*.env.yaml`); other YAML in the folder is ignored.

## Editor support

With the YAML extension for VS Code (Red Hat), add to `.vscode/settings.json` in the collection to get completion, hover documentation and red squiggles:

```json
{
  "yaml.schemas": {
    "https://batuhanilgarr.github.io/Reqnest/schema/v1/request.schema.json": "**/*.req.yaml",
    "https://batuhanilgarr.github.io/Reqnest/schema/v1/folder.schema.json": "**/folder.yaml",
    "https://batuhanilgarr.github.io/Reqnest/schema/v1/collection.schema.json": "/cairn.yaml",
    "https://batuhanilgarr.github.io/Reqnest/schema/v1/environment.schema.json": "environments/*.env.yaml"
  }
}
```

Or per file, as a first-line comment: `# yaml-language-server: $schema=https://batuhanilgarr.github.io/Reqnest/schema/v1/request.schema.json`.

## A request: `*.req.yaml`

The file name is the request's slug; `name` is what the tree shows. The smallest request:

```yaml request
name: Health
method: GET
url: "{{baseUrl}}/health"
```

A fuller one. Keys come in this order; every key except `name` and `url` is optional:

```yaml request
name: Create invoice
method: POST
url: "{{baseUrl}}/v1/invoices?expand=customer"
headers:
  - key: Idempotency-Key
    value: "{{$guid}}"
  - key: X-Debug
    value: "1"
    enabled: false
body:
  mode: json
  content: |-
    {
      "customer": "{{customerId}}",
      "amount": 12900
    }
auth:
  mode: bearer
  token: "{{token}}"
examples:
  - name: Created
    status: 201
    headers:
      - key: Content-Type
        value: application/json
    body: '{"id": "inv_1", "status": "draft"}'
    delay: 150
tests:
  - kind: status
    op: eq
    value: "201"
  - kind: json
    path: $.id
    op: exists
capture:
  - variable: invoiceId
    from: json
    path: $.id
scripts:
  pre: pm.environment.set("when", Date.now());
  post: pm.test("created", () => pm.response.to.have.status(201));
settings:
  timeoutMs: 5000
```

| Key | Meaning |
|---|---|
| `type` | `graphql`, `sse`, `ws`, `grpc` or `mcp`. Left out for HTTP. |
| `method` | HTTP method. Left out for `graphql`, `ws`, `grpc`, `mcp`. |
| `url` | The full URL **including the query string**. The Params table in the app is a view of it. |
| `params` | Only query parameters that are *switched off*; enabled ones are in `url`. |
| `headers` | Rows of `key`, `value` and (only when off) `enabled: false`. |
| `body` | `mode` is `json`, `text`, `form`, `multipart` or `binary`, with `content`; multipart has `parts` (`key` plus `value` or `file`, optional `contentType`). |
| `auth` | `mode`: `inherit`, `bearer`, `basic` or `oauth2`. Left out means no auth. |
| `examples` | Saved responses; the mock server answers with them. |
| `tests` | Assertions: `kind` (`status`, `json`, `header`, `body`, `time`), `path`, `op` (`eq`, `neq`, `contains`, `matches`, `exists`, `lt`, `gt`), `value`. |
| `capture` | Values copied from the response into variables (`from`: `json` or `header`). |
| `scripts` | `pre` and `post` JavaScript. |
| `settings` | `followRedirects: false`, `insecure: true`, `timeoutMs`: only when they differ from the defaults. |
| `source` | Written by imports so a re-sync updates the request in place. |

Other protocols keep their settings under their own key:

```yaml request
name: Orders
type: graphql
url: "{{baseUrl}}/graphql"
graphql:
  query: |-
    query Orders($first: Int) {
      orders(first: $first) { id total }
    }
  variables: '{"first": 10}'
  operation: Orders
```

```yaml request
name: Live prices
type: ws
url: wss://stream.example.com/prices
websocket:
  protocols: v1
  message: '{"subscribe": "BTC"}'
  saved:
    - name: Subscribe
      body: '{"subscribe": "BTC"}'
```

```yaml request
name: Say hello
type: grpc
url: api.example.com:443
grpc:
  source: reflection
  method: helloworld.Greeter/SayHello
  message: '{"name": "Ada"}'
```

```yaml request
name: Local tools
type: mcp
url: ""
mcp:
  transport: stdio
  command: npx
  args: -y @modelcontextprotocol/server-everything
```

### Shared requests

A file that holds only `use:` is a link to a request kept elsewhere. The content comes from that file, so one definition serves many folders and collections; headers, auth and variables still come from where the link sits.

```yaml request
use: ../shared/login.req.yaml
```

## Folder defaults: `folder.yaml`

Defaults for every request in the folder and below (the collection root has one too). A deeper level overrides a shallower one, and a request overrides both. A switched-off header row removes an inherited header.

```yaml folder
vars:
  - key: team
    value: core
headers:
  - key: X-Team
    value: "{{team}}"
auth:
  mode: bearer
  token: "{{token}}"
scripts:
  pre: |-
    pm.request.headers.add({ key: "X-Run", value: Date.now() });
```

Variables here are defaults: an environment or a script can override them. They are committed, so keep secrets out.

## The collection: `cairn.yaml`

```yaml collection
name: Payments
```

An OpenAPI import adds `openapi.source` so it can be re-synced:

```yaml collection
name: Payments
openapi:
  source: https://api.example.com/openapi.json
```

## Environments: `environments/*.env.yaml`

```yaml environment
name: Staging
extends: Base
vars:
  - key: baseUrl
    value: https://staging.example.com
  - key: token
    value: ""
    secret: true
  - key: debug
    value: "1"
    enabled: false
```

`extends` names another environment whose variables apply first. A variable with `secret: true` is written with an **empty value**: the real value lives in `.cairn/secrets.yaml`, which Cairn adds to `.gitignore`. That secrets file is local to your machine, not part of the format, and has no schema:

```yaml
# .cairn/secrets.yaml (never committed)
staging.env.yaml:
  token: the-real-value
```

## What is not in the format

Session variables (set by scripts and captures), OAuth tokens, cookies and response history live in memory or in the app's own settings and are never written into the collection.
