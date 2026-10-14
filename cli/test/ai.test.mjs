import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "../..");
let A, U, server, base;
const seen = [];

before(async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-ai-")), "ai.mjs");
  await build({
    entryPoints: [path.join(ROOT, "src/lib/ai.ts")],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    alias: { "@tauri-apps/api/core": path.join(ROOT, "cli/shims/tauri-core.ts") },
  });
  A = await import(out);
  const out2 = path.join(path.dirname(out), "util.mjs");
  await build({ entryPoints: [path.join(ROOT, "src/lib/util.ts")], outfile: out2, bundle: true, platform: "node", format: "esm", logLevel: "silent", alias: { "@tauri-apps/api/core": path.join(ROOT, "cli/shims/tauri-core.ts") } });
  U = await import(out2);

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      const json = (code, obj) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(obj)));
      if (req.url === "/ollama/api/tags") return json(200, { models: [{ name: "qwen3.8:27b" }, { name: "llama3.2:3b" }] });
      if (req.url === "/ollama/api/chat") {
        if (req.headers.authorization === "Bearer bad") return json(401, { error: "unauthorized" });
        return json(200, { message: { role: "assistant", content: "<think>\nhmm\n</think>\nHello from Ollama" } });
      }
      if (req.url === "/openai/v1/models") return json(200, { data: [{ id: "gpt-b" }, { id: "gpt-a" }] });
      if (req.url === "/openai/v1/chat/completions") return json(200, { choices: [{ message: { role: "assistant", content: "Hello from OpenAI" } }] });
      if (req.url === "/html/api/tags") return (res.writeHead(200, { "content-type": "text/html" }), res.end("<html>nope</html>"));
      return json(404, { error: "not found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const cfg = (over) => ({ ...A.DEFAULT_AI, ...over });

test("normalizeBase accepts a pasted endpoint and adds /v1 for bare OpenAI-style hosts", () => {
  assert.equal(A.normalizeBase("https://ollama.8bitiz.com/api/generate", "ollama"), "https://ollama.8bitiz.com");
  assert.equal(A.normalizeBase("https://x.io/api/chat/", "ollama"), "https://x.io");
  assert.equal(A.normalizeBase("https://api.openai.com/v1/chat/completions?x=1", "openai"), "https://api.openai.com/v1");
  assert.equal(A.normalizeBase("https://api.openai.com", "openai"), "https://api.openai.com/v1");
  assert.equal(A.normalizeBase("https://openrouter.ai/api/v1", "openai"), "https://openrouter.ai/api/v1");
});

test("Ollama: models, chat, no_think and the auth header only when there is a token", async () => {
  const c = cfg({ format: "ollama", baseUrl: `${base}/ollama/api/generate`, model: "qwen3.8:27b", noThink: true });
  assert.deepEqual(await A.listModels(c), ["llama3.2:3b", "qwen3.8:27b"]);
  const text = await A.chat(c, [{ role: "system", content: "sys" }, { role: "user", content: "Merhaba" }]);
  const sent = seen.findLast((r) => r.url === "/ollama/api/chat");
  assert.equal(sent.body.model, "qwen3.8:27b");
  assert.equal(sent.body.stream, false);
  assert.equal(sent.body.messages.at(-1).content, "Merhaba /no_think");
  assert.equal(sent.headers.authorization, undefined, "no token, no Authorization header");
  assert.deepEqual(A.splitThinking(text), { answer: "Hello from Ollama", thinking: "hmm" });

  await A.chat({ ...c, token: "t0k" }, [{ role: "user", content: "hi" }]);
  assert.equal(seen.findLast((r) => r.url === "/ollama/api/chat").headers.authorization, "Bearer t0k");
  await A.chat({ ...c, token: "raw", authHeader: "X-Api-Key", authScheme: "" }, [{ role: "user", content: "hi" }]);
  assert.equal(seen.findLast((r) => r.url === "/ollama/api/chat").headers["x-api-key"], "raw");
});

test("OpenAI-compatible: models and chat completions", async () => {
  const c = cfg({ format: "openai", baseUrl: `${base}/openai/v1`, token: "sk-1", model: "gpt-a" });
  assert.deepEqual(await A.listModels(c), ["gpt-a", "gpt-b"]);
  assert.equal(await A.chat(c, [{ role: "user", content: "hi" }]), "Hello from OpenAI");
  const sent = seen.findLast((r) => r.url === "/openai/v1/chat/completions");
  assert.equal(sent.headers.authorization, "Bearer sk-1");
  assert.equal(sent.body.messages[0].content, "hi", "no /no_think unless asked for");
});

test("errors say what to check", async () => {
  const c = cfg({ format: "ollama", baseUrl: `${base}/ollama`, model: "m", token: "bad" });
  await assert.rejects(() => A.chat(c, [{ role: "user", content: "x" }]), /401.*unauthorized.*token/s);
  await assert.rejects(() => A.chat(cfg({ format: "ollama", baseUrl: `${base}/nowhere`, model: "m" }), [{ role: "user", content: "x" }]), /404.*endpoint and the model/s);
  await assert.rejects(() => A.listModels(cfg({ format: "ollama", baseUrl: `${base}/html` })), /didn't answer with JSON/);
  await assert.rejects(() => A.chat(cfg({ baseUrl: base }), []), /Pick a model/);
  await assert.rejects(() => A.chat(cfg({ model: "m" }), []), /Set an AI endpoint/);
});

test("the settings can be filled from the curl you already use (an empty `Authorization;` means no auth)", () => {
  const r = A.configFromCurl(`curl --location 'https://ollama.8bitiz.com/api/generate' \\
--header 'Content-Type: application/json' \\
--header 'Authorization;' \\
--data '{
    "model": "qwen3.8:27b",
    "prompt": "Merhaba /nothinking /no_think",
    "stream": false
}'`);
  assert.equal(r.format, "ollama");
  assert.equal(r.baseUrl, "https://ollama.8bitiz.com");
  assert.equal(r.model, "qwen3.8:27b");
  assert.equal(r.token, "");
  assert.equal(r.noThink, true);
  assert.ok(r.notes.some((n) => /No auth header/.test(n)));

  const o = A.configFromCurl(`curl https://api.openai.com/v1/chat/completions -H "Authorization: Bearer sk-abc" -d '{"model":"gpt-4o-mini","messages":[]}'`);
  assert.equal(o.format, "openai");
  assert.equal(o.baseUrl, "https://api.openai.com/v1");
  assert.equal(o.token, "sk-abc");
  assert.equal(o.authScheme, "Bearer");
  assert.equal(o.model, "gpt-4o-mini");
  assert.throws(() => A.configFromCurl("curl"), /doesn't look like/);
});

test("what the model sees: variables stay unresolved, credentials are hidden, big bodies are cut", () => {
  const tab = {
    ...U.newTab(),
    method: "POST",
    url: "{{baseUrl}}/v1/login?x=1",
    authMode: "bearer",
    authToken: "SUPER-SECRET",
    headers: [{ id: "1", key: "Authorization", value: "Bearer SUPER-SECRET", enabled: true }, { id: "2", key: "X-Trace", value: "t-1", enabled: true }, { id: "3", key: "X-Off", value: "no", enabled: false }],
    bodyMode: "json",
    body: '{"user":"ada","password":"hunter2","api_key":"k-123","nested":{"clientSecret":"s"}}',
  };
  const response = { status: 401, statusText: "Unauthorized", headers: [["set-cookie", "sid=abc"], ["content-type", "application/json"]], body: JSON.stringify({ error: "bad", access_token: "tok-999" }), contentType: "application/json", sizeBytes: 40, timeMs: 12, httpVersion: "HTTP/1.1" };
  const text = A.buildContext(tab, response, { body: true, response: true });
  assert.match(text, /POST \{\{baseUrl\}\}\/v1\/login\?x=1/);
  assert.match(text, /X-Trace: t-1/);
  assert.doesNotMatch(text, /X-Off/);
  assert.match(text, /Authorization: <hidden>/);
  for (const secret of ["SUPER-SECRET", "hunter2", "k-123", "tok-999", "sid=abc"]) assert.ok(!text.includes(secret), `${secret} must not be sent`);
  assert.match(text, /"user":"ada"/);
  assert.match(text, /Last response: 401 Unauthorized/);
  const without = A.buildContext(tab, response, { body: false, response: false });
  assert.doesNotMatch(without, /ada|Last response/);
  const big = A.safeBody("x".repeat(9000));
  assert.ok(big.length < 6100 && /3000 more characters/.test(big));
});
