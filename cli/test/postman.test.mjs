import test, { before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "../..");
let P; // the Postman importer, bundled for Node

before(async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-pm-")), "postman.mjs");
  await build({
    entryPoints: [path.join(ROOT, "src/lib/postman.ts")],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    alias: { "@tauri-apps/api/core": path.join(ROOT, "cli/shims/tauri-core.ts") },
  });
  P = await import(out);
});

const kv = (key, value, extra = {}) => ({ key, value, ...extra });

const collection = {
  info: { name: "Payments", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  auth: { type: "oauth2", oauth2: [kv("grant_type", "client_credentials"), kv("accessTokenUrl", "https://auth.example.com/token"), kv("clientId", "cid"), kv("clientSecret", "s3cr3t"), kv("scope", "read write"), kv("client_authentication", "body")] },
  variable: [kv("baseUrl", "https://api.example.com"), kv("version", "v2")],
  event: [{ listen: "prerequest", script: { exec: ["pm.environment.set('t', Date.now());"] } }],
  item: [
    {
      name: "Invoices",
      auth: { type: "bearer", bearer: [kv("token", "{{jwt}}")] },
      variable: [kv("limit", "50")],
      event: [{ listen: "test", script: { exec: ["pm.test('ok', () => pm.response.to.have.status(200));"] } }],
      item: [
        {
          name: "List invoices",
          request: {
            method: "GET",
            header: [kv("Accept", "application/json"), kv("X-Off", "1", { disabled: true })],
            url: { raw: "{{baseUrl}}/{{version}}/invoices/:id?status=open", host: ["{{baseUrl}}"], path: ["{{version}}", "invoices", ":id"], variable: [kv("id", "42")], query: [kv("status", "open"), kv("debug", "1", { disabled: true })] },
          },
          response: [{ name: "Two invoices", code: 200, header: [kv("Content-Type", "application/json")], body: '{"data":[1,2]}' }],
        },
        {
          name: "Upload receipt",
          request: {
            method: "POST",
            auth: { type: "apikey", apikey: [kv("key", "X-Api-Key"), kv("value", "{{apiKey}}"), kv("in", "header")] },
            body: { mode: "formdata", formdata: [{ key: "memo", value: "hi", type: "text" }, { key: "file", type: "file", src: "/Users/me/receipt.pdf", contentType: "application/pdf" }] },
            url: "{{baseUrl}}/receipts",
          },
        },
        {
          name: "Create (xml)",
          request: { method: "POST", header: [], auth: { type: "noauth" }, body: { mode: "raw", raw: "<a/>", options: { raw: { language: "xml" } } }, url: "{{baseUrl}}/xml" },
          event: [{ listen: "test", script: { exec: ["const r = await pm.sendRequest('x');"] } }],
        },
      ],
    },
    { name: "Search", request: { method: "POST", body: { mode: "graphql", graphql: { query: "{ me { id } }", variables: '{"a":1}' } }, url: "{{baseUrl}}/graphql" } },
    { name: "Raw file", request: { method: "PUT", body: { mode: "file", file: { src: "/tmp/a.bin" } }, url: "{{baseUrl}}/blob?x={{$randomFirstName}}" } },
    { name: "Basic thing", request: { method: "GET", auth: { type: "basic", basic: [kv("username", "ada"), kv("password", "hunter2")] }, url: "{{baseUrl}}/b" } },
    { name: "Digest thing", request: { method: "GET", auth: { type: "digest", digest: [] }, url: "{{baseUrl}}/d" } },
  ],
};

test("a collection becomes a folder with its settings, requests, auth and scripts", () => {
  const r = P.parsePostman(JSON.stringify(collection));
  assert.equal(r.title, "Payments");
  assert.equal(r.requests.length, 7);

  // folder defaults: collection root keeps oauth2 + variables + script, the Invoices folder its own auth/vars/script
  const root = r.folders.find((f) => f.path.join("/") === "Payments");
  assert.equal(root.defaults.authMode, "oauth2");
  assert.equal(root.defaults.oauth.grant, "client_credentials");
  assert.equal(root.defaults.oauth.tokenUrl, "https://auth.example.com/token");
  assert.equal(root.defaults.oauth.clientAuth, "body");
  assert.equal(root.defaults.oauth.clientSecret, "{{payments_client_secret}}", "a literal secret is replaced by a variable");
  assert.deepEqual(root.defaults.vars.filter((v) => v.key).map((v) => [v.key, v.value]), [["baseUrl", "https://api.example.com"], ["version", "v2"]]);
  assert.match(root.defaults.preScript, /pm\.environment\.set/);
  const inv = r.folders.find((f) => f.path.join("/") === "Payments/Invoices");
  assert.equal(inv.defaults.authMode, "bearer");
  assert.equal(inv.defaults.authToken, "{{jwt}}", "a value that already is a variable is left alone");
  assert.equal(inv.defaults.vars.find((v) => v.key === "limit").value, "50");
  assert.match(inv.defaults.postScript, /pm\.test/);

  const by = (name) => r.requests.find((x) => x.base === name);
  const list = by("List invoices");
  assert.deepEqual(list.folder, ["Payments", "Invoices"]);
  assert.equal(list.tab.url, "{{baseUrl}}/{{version}}/invoices/42?status=open", "path variable filled in");
  assert.equal(list.tab.authMode, "inherit");
  assert.equal(list.tab.headers.find((h) => h.key === "X-Off").enabled, false);
  assert.equal(list.tab.params.find((p) => p.key === "debug").enabled, false, "disabled query params are kept, disabled");
  assert.equal(list.tab.examples[0].name, "Two invoices");
  assert.equal(list.tab.examples[0].status, 200);

  const up = by("Upload receipt");
  assert.equal(up.tab.bodyMode, "multipart");
  assert.deepEqual(up.tab.formParts.filter((p) => p.key).map((p) => [p.key, p.kind, p.value, p.contentType]), [["memo", "text", "hi", undefined], ["file", "file", "/Users/me/receipt.pdf", "application/pdf"]]);
  assert.ok(up.tab.headers.some((h) => h.key === "X-Api-Key" && h.value === "{{apiKey}}"), "API key becomes a header");

  // basic auth with a literal password: the password is taken out of the request, the value is handed back as a secret
  const basic = by("Basic thing");
  assert.equal(basic.tab.authMode, "basic");
  assert.equal(basic.tab.authUser, "ada");
  assert.match(basic.tab.authPass, /^\{\{payments_.*password\}\}$/);
  assert.equal(r.secrets[basic.tab.authPass.slice(2, -2)], "hunter2");
  assert.equal(r.secrets.payments_client_secret, "s3cr3t");
  assert.ok(!JSON.stringify(r.requests.map((x) => x.tab)).includes("hunter2") && !JSON.stringify(r.folders).includes("s3cr3t"), "no literal credential is left in anything that gets written to disk");

  const xml = by("Create (xml)");
  assert.equal(xml.tab.authMode, "none");
  assert.equal(xml.tab.bodyMode, "text");
  assert.ok(xml.tab.headers.some((h) => h.key === "Content-Type" && h.value === "application/xml"));

  const gql = by("Search");
  assert.equal(gql.tab.kind, "graphql");
  assert.equal(gql.tab.gql.query, "{ me { id } }");
  assert.equal(gql.tab.gql.variables, '{"a":1}');

  const file = by("Raw file");
  assert.equal(file.tab.bodyMode, "binary");
  assert.equal(file.tab.body, "/tmp/a.bin");

  assert.ok(r.notes.some((n) => /sendRequest/.test(n)), "unsupported script APIs are called out");
  assert.ok(r.notes.some((n) => /digest auth/.test(n)));
  assert.ok(r.notes.some((n) => /\$randomFirstName/.test(n)), "dynamic variables Cairn doesn't generate are reported");
  assert.ok(r.notes.some((n) => /receipt/.test(n) && /file fields/.test(n)));
});

test("collections wrapped by the Postman API and detection of export kinds", () => {
  assert.equal(P.detectPostman(JSON.stringify({ collection })), "collection");
  assert.equal(P.parsePostman(JSON.stringify({ collection })).requests.length, 7);
  assert.equal(P.detectPostman(JSON.stringify({ name: "Prod", values: [], _postman_variable_scope: "environment" })), "environment");
  assert.equal(P.detectPostman(JSON.stringify({ name: "Globals", values: [], _postman_variable_scope: "globals" })), "globals");
  assert.equal(P.detectPostman("{}"), "unknown");
  assert.equal(P.detectPostman("not json"), "unknown");
});

test("environments keep secret variables secret and skip disabled ones", () => {
  const env = P.parsePostmanEnvironment(
    JSON.stringify({
      name: "Production",
      _postman_variable_scope: "environment",
      values: [
        { key: "baseUrl", value: "https://prod.example.com", type: "default", enabled: true },
        { key: "jwt", value: "eyJ.secret", type: "secret", enabled: true },
        { key: "old", value: "x", enabled: false },
      ],
    }),
  );
  assert.equal(env.name, "Production");
  assert.equal(env.scope, "environment");
  assert.deepEqual(env.vars, [{ key: "baseUrl", value: "https://prod.example.com", secret: false }, { key: "jwt", value: "eyJ.secret", secret: true }]);
  assert.equal(env.skipped, 1);
});
