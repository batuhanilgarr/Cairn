import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { build } from "esbuild";
import { Server } from "socket.io";
import { WebSocket, WebSocketServer } from "ws";

/** The client is tested against the real Socket.IO server (v4), not against our own idea of the protocol. */
const ROOT = path.resolve(import.meta.dirname, "../..");
let S, httpServer, io, port, seen;

before(async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-sio-")), "socketio.mjs");
  await build({ entryPoints: [path.join(ROOT, "src/lib/socketio.ts")], outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  S = await import(out);

  seen = { disconnects: [], acks: [] };
  httpServer = http.createServer();
  io = new Server(httpServer, { pingInterval: 100, pingTimeout: 400 });
  io.on("connection", (socket) => {
    socket.on("echo", (data, cb) => cb({ echo: data }));
    socket.on("chat", (msg) => socket.emit("chat reply", { text: `got ${msg.text}` }));
    socket.on("multi", (a, b, c) => socket.emit("multi reply", a + b, { c }));
    socket.on("whoami", () => socket.emit("you are", socket.handshake.auth));
    socket.on("ask me", () => socket.timeout(2000).emit("need ack", (err, res) => seen.acks.push({ err: err ? String(err) : null, res })));
    socket.on("kick", () => socket.disconnect());
    socket.on("disconnect", (reason) => seen.disconnects.push(reason));
  });
  const admin = io.of("/admin");
  admin.use((s, next) => (s.handshake.auth?.token === "secret" ? next() : next(Object.assign(new Error("nope"), { data: { why: "bad token" } }))));
  admin.on("connection", (socket) => socket.on("hello", () => socket.emit("welcome", "admin")));
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  port = httpServer.address().port;
});
after(async () => {
  io.close();
  httpServer.closeAllConnections?.();
  await new Promise((r) => httpServer.close(r));
});

/** Connect the way the app does: the client decides what to send, we only carry frames. */
async function open(address, { namespace = "", path: p = "", auth = "" } = {}) {
  const target = S.sioTarget(address ?? `http://127.0.0.1:${port}`, namespace, p);
  const client = new S.SioClient({ namespace: target.namespace, auth });
  const ws = new WebSocket(target.url);
  const log = { entries: [], status: undefined, info: undefined, frames: [] };
  const waiters = [];
  const poke = () => waiters.slice().forEach((w) => w());
  ws.on("message", (data, isBinary) => {
    const step = isBinary ? client.onBinary(data.length) : client.onText(data.toString());
    for (const f of step.send) (log.frames.push(f), ws.send(f));
    log.entries.push(...step.entries);
    if (step.status) log.status = step.status;
    if (step.info !== undefined) log.info = step.info;
    poke();
  });
  ws.on("close", () => ((log.closed = true), poke()));
  const until = (pred, what = "condition", ms = 3000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}; log: ${JSON.stringify(log)}`)), ms);
      const check = () => {
        if (pred()) (clearTimeout(t), waiters.splice(waiters.indexOf(check), 1), resolve());
      };
      waiters.push(check);
      check();
    });
  const emit = (event, args = [], ack = false) => {
    const { frame, entry } = client.emit(event, args, ack);
    ws.send(frame);
    log.entries.push(entry);
  };
  return { client, ws, log, until, emit, target, close: () => ws.close() };
}
const find = (log, label) => log.entries.find((e) => e.label === label);

test("addresses: the origin picks the server, a path is the namespace, the Socket.IO path is configurable", () => {
  assert.deepEqual(S.sioTarget("https://chat.example.com", "", ""), { url: "wss://chat.example.com/socket.io/?EIO=4&transport=websocket", namespace: "/" });
  assert.deepEqual(S.sioTarget("chat.example.com:3000/admin", "", ""), { url: "ws://chat.example.com:3000/socket.io/?EIO=4&transport=websocket", namespace: "/admin" });
  assert.equal(S.sioTarget("http://h/admin", "/other", "").namespace, "/other", "the field beats the path in the address");
  assert.equal(S.sioTarget("http://h", "chat", "").namespace, "/chat", "a missing slash is added");
  assert.equal(S.sioTarget("http://h", "", "realtime").url, "ws://h/realtime/?EIO=4&transport=websocket");
  assert.equal(S.sioTarget("wss://h/?token=1", "", "").url, "wss://h/socket.io/?token=1&EIO=4&transport=websocket", "an existing query is kept");
  assert.throws(() => S.sioTarget("ftp://h", "", ""), /http\(s\):\/\/ or ws\(s\):\/\//);
});

test("packets are encoded the way the protocol says, and decoded back", () => {
  assert.equal(S.encodeConnect("/", ""), "40");
  assert.equal(S.encodeConnect("/", '{ "a": 1 }'), '40{"a":1}');
  assert.equal(S.encodeConnect("/admin", ""), "40/admin,");
  assert.equal(S.encodeConnect("/admin", '{"t":"x"}'), '40/admin,{"t":"x"}');
  assert.equal(S.encodeEvent("/", "hi", [1, { a: 2 }]), '42["hi",1,{"a":2}]');
  assert.equal(S.encodeEvent("/chat", "hi", [], 7), '42/chat,7["hi"]');
  assert.equal(S.encodeAck("/chat", 7, ["ok"]), '43/chat,7["ok"]');
  assert.equal(S.encodeDisconnect("/"), "41");
  assert.equal(S.encodeDisconnect("/chat"), "41/chat,");
  assert.deepEqual(S.parseSioPacket('2["e",{"x":1}]'), { type: 2, namespace: "/", data: ["e", { x: 1 }] });
  assert.deepEqual(S.parseSioPacket('2/chat,12["e"]'), { type: 2, namespace: "/chat", id: 12, data: ["e"] });
  assert.deepEqual(S.parseSioPacket('0{"sid":"a"}'), { type: 0, namespace: "/", data: { sid: "a" } });
  assert.deepEqual(S.parseSioPacket("1/admin,"), { type: 1, namespace: "/admin" });
  assert.deepEqual(S.parseSioPacket('51-["f",{"_placeholder":true,"num":0}]'), { type: 5, namespace: "/", attachments: 1, data: ["f", { _placeholder: true, num: 0 }] });
  assert.match(S.parseSioPacket("2[oops").error, /invalid JSON/);
  assert.match(S.parseSioPacket("x").error, /Unknown packet type/);
});

test("arguments and auth are checked before anything is sent", () => {
  assert.deepEqual(S.parseSioArgs(""), { args: [] });
  assert.deepEqual(S.parseSioArgs('[1, "a", {"b": 2}]'), { args: [1, "a", { b: 2 }] });
  assert.match(S.parseSioArgs('{"a":1}').error, /JSON array/);
  assert.match(S.parseSioArgs("[1,").error, /Not valid JSON/);
  assert.equal(S.sioAuthError(""), null);
  assert.equal(S.sioAuthError('{"token":"x"}'), null);
  assert.match(S.sioAuthError('["x"]'), /must be a JSON object/);
  assert.match(S.sioAuthError("{nope"), /isn't valid JSON/);
});

test("connecting: handshake, namespace connect and the socket id", async () => {
  const c = await open();
  await c.until(() => c.log.status === "open", "connected");
  assert.match(find(c.log, "engine.io").text, /Handshake done \(session \S+\), the server pings every 0\.1 s/);
  assert.match(find(c.log, "connected").text, /Namespace \/, socket id \S+/);
  assert.match(c.log.info, /^\/ · \S+$/);
  assert.equal(c.client.connected, true);
  c.close();
});

test("emit with an acknowledgement: the answer is matched to the event that asked for it", async () => {
  const c = await open();
  await c.until(() => c.log.status === "open");
  c.emit("echo", [{ n: 1 }, "x"].slice(0, 1), true);
  await c.until(() => c.log.entries.some((e) => e.label === "ack · echo"), "the ack");
  const out = c.log.entries.find((e) => e.dir === "out" && e.label.startsWith("echo"));
  assert.equal(out.label, "echo · wants ack");
  const ack = find(c.log, "ack · echo");
  assert.match(ack.text, /"echo": \{\s+"n": 1\s+\}/);
  assert.match(ack.text, /\(\d+ ms after the emit\)/);
  c.close();
});

test("events from the server, with one or several arguments", async () => {
  const c = await open();
  await c.until(() => c.log.status === "open");
  c.emit("chat", [{ text: "hi" }]);
  c.emit("multi", [2, 3, "z"]);
  await c.until(() => find(c.log, "chat reply") && find(c.log, "multi reply"), "both replies");
  assert.equal(find(c.log, "chat reply").dir, "in");
  assert.match(find(c.log, "chat reply").text, /"text": "got hi"/);
  assert.deepEqual(JSON.parse(find(c.log, "multi reply").text), [5, { c: "z" }], "several arguments show as a list");
  assert.equal(find(c.log, "chat").text.includes('"text": "hi"'), true, "what we sent is logged too");
  c.close();
});

test("an ack the server asks for is answered automatically", async () => {
  seen.acks.length = 0;
  const c = await open();
  await c.until(() => c.log.status === "open");
  c.emit("ask me");
  await c.until(() => find(c.log, "need ack"), "the server's event");
  await c.until(() => seen.acks.length === 1, "the server to get the ack");
  assert.deepEqual(seen.acks[0], { err: null, res: undefined }, "the server's callback ran without a timeout");
  assert.ok(c.log.entries.some((e) => /^ack \d+$/.test(e.label) && /sent automatically/.test(e.text)));
  c.close();
});

test("the auth payload reaches the server (socket.handshake.auth)", async () => {
  const c = await open(undefined, { auth: '{ "token": "t-1", "n": 2 }' });
  await c.until(() => c.log.status === "open");
  c.emit("whoami");
  await c.until(() => find(c.log, "you are"), "the answer");
  assert.deepEqual(JSON.parse(find(c.log, "you are").text), { token: "t-1", n: 2 });
  c.close();
});

test("a namespace: connects with the right auth, is refused with the wrong one and says why", async () => {
  const ok = await open(undefined, { namespace: "/admin", auth: '{"token":"secret"}' });
  await ok.until(() => ok.log.status === "open");
  assert.match(find(ok.log, "connected").text, /Namespace \/admin/);
  ok.emit("hello");
  await ok.until(() => find(ok.log, "welcome"), "the welcome");
  assert.equal(find(ok.log, "welcome").text, "admin", "a string argument shows as the string");
  ok.close();

  for (const auth of ['{"token":"wrong"}', ""]) {
    const bad = await open(undefined, { namespace: "admin", auth });
    await bad.until(() => bad.log.status === "error", "the refusal");
    const refused = find(bad.log, "refused");
    assert.match(refused.text, /The server refused \/admin: nope/);
    assert.match(refused.text, /"why": "bad token"/);
    assert.equal(refused.tone, "error");
    assert.equal(bad.client.connected, false);
    bad.close();
  }
});

test("emitting before the namespace is connected, or without a name, is refused", async () => {
  const client = new S.SioClient({ namespace: "/", auth: "" });
  assert.throws(() => client.emit("x", [], false), /Not connected/);
  client.connected = true;
  assert.throws(() => client.emit("  ", [], false), /name/);
});

test("disconnecting says goodbye to the server; the server can disconnect us too", async () => {
  seen.disconnects.length = 0;
  const c = await open();
  await c.until(() => c.log.status === "open");
  const bye = c.client.disconnect();
  assert.deepEqual(bye, ["41"]);
  c.ws.send(bye[0]);
  await c.until(() => seen.disconnects.length === 1, "the server to notice");
  assert.equal(seen.disconnects[0], "client namespace disconnect");
  assert.deepEqual(c.client.disconnect(), [], "saying it twice sends nothing");
  c.close();

  const k = await open();
  await k.until(() => k.log.status === "open");
  k.emit("kick");
  await k.until(() => k.log.status === "closed", "the disconnect");
  assert.match(find(k.log, "disconnected").text, /The server disconnected this socket/);
  k.close();
});

test("pings are answered, so the server keeps the connection (ping every 100 ms, gives up after 400 ms)", async () => {
  const c = await open();
  await c.until(() => c.log.status === "open");
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(c.log.closed, undefined, "still connected after a dozen pings");
  assert.ok(c.log.frames.filter((f) => f === "3").length >= 5, `pongs sent: ${c.log.frames.filter((f) => f === "3").length}`);
  c.close();
});

test("a server that is not Socket.IO gets a clear error", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.on("listening", r));
  wss.on("connection", (s) => s.send("hello there"));
  const c = await open(`http://127.0.0.1:${wss.address().port}`);
  await c.until(() => c.log.status === "error", "the error");
  assert.match(find(c.log, "error").text, /isn't a Socket\.IO handshake/);
  c.close();
  wss.close();
});

test("a bad auth payload stops the connection instead of sending garbage", async () => {
  const client = new S.SioClient({ namespace: "/", auth: "{nope" });
  const step = client.onText('0{"sid":"abc","pingInterval":25000}');
  assert.deepEqual(step.send, []);
  assert.equal(step.status, "error");
  assert.match(step.entries.at(-1).text, /isn't valid JSON/);
});

test("a Socket.IO request is saved as type: socketio and read back unchanged", async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-sio-c-")), "collection.mjs");
  await build({
    entryPoints: [path.join(ROOT, "src/lib/collection.ts")], outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    alias: { "@tauri-apps/api/core": path.join(ROOT, "cli/shims/tauri-core.ts"), "@tauri-apps/plugin-dialog": path.join(ROOT, "cli/shims/plugin-dialog.ts"), "@tauri-apps/plugin-opener": path.join(ROOT, "cli/shims/plugin-opener.ts") },
  });
  const C = await import(out);
  const yaml = `name: Chat\ntype: socketio\nurl: https://chat.example.com\nsocketio:\n  namespace: /chat\n  path: /rt/\n  auth: '{"token": "{{token}}"}'\n  event: message\n  message: '[{"text": "hi"}]'\n  ack: true\n  saved:\n    - name: Join\n      event: join\n      body: '["lobby"]'\n`;
  const tab = C.parseRequest(yaml, "/x/chat.req.yaml");
  assert.equal(tab.kind, "sio");
  assert.deepEqual({ ...tab.sio, messages: tab.sio.messages.map(({ id, ...m }) => m) }, { namespace: "/chat", path: "/rt/", auth: '{"token": "{{token}}"}', event: "message", composer: '[{"text": "hi"}]', ack: true, messages: [{ name: "Join", event: "join", body: '["lobby"]' }] });
  const again = C.serializeRequest(tab);
  assert.match(again, /^type: socketio$/m);
  assert.doesNotMatch(again, /^method:/m, "Socket.IO has no HTTP method");
  assert.match(again, /ack: true/);
  const back = C.parseRequest(again, "/x/chat.req.yaml");
  assert.equal(C.serializeRequest(back), again, "saving what was read changes nothing");
  assert.equal(C.parseRequest("name: P\nurl: https://x.io\n", "/x/p.req.yaml").kind, "http", "a plain request is still HTTP");
});
