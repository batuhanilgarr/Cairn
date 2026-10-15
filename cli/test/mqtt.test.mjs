import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { build } from "esbuild";
import { Aedes } from "aedes";
import { WebSocket, WebSocketServer, createWebSocketStream } from "ws";

/** The client is tested against a real broker (aedes), over TCP and over a WebSocket. */
const ROOT = path.resolve(import.meta.dirname, "../..");
let M, broker, tcpServer, httpServer, wss, tcpPort, wsPort;
let seenWill = [];

before(async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-mqtt-")), "mqtt.mjs");
  await build({ entryPoints: [path.join(ROOT, "src/lib/mqtt.ts")], outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  M = await import(out);

  broker = await Aedes.createBroker();
  broker.authenticate = (client, username, password, cb) => {
    if (username === undefined) return cb(null, true);
    const ok = username === "ada" && password?.toString() === "pw";
    cb(ok ? null : Object.assign(new Error("bad"), { returnCode: 4 }), ok);
  };
  broker.authorizeSubscribe = (client, sub, cb) => cb(null, sub.topic.startsWith("denied/") ? null : sub);
  tcpServer = net.createServer((s) => broker.handle(s));
  await new Promise((r) => tcpServer.listen(0, "127.0.0.1", r));
  tcpPort = tcpServer.address().port;

  httpServer = http.createServer();
  wss = new WebSocketServer({ server: httpServer, handleProtocols: (protocols) => (protocols.has("mqtt") ? "mqtt" : false) });
  wss.on("connection", (ws) => broker.handle(createWebSocketStream(ws)));
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  wsPort = httpServer.address().port;
});
after(async () => {
  await new Promise((r) => broker.close(r));
  wss.close();
  httpServer.closeAllConnections?.();
  tcpServer.close();
  await new Promise((r) => httpServer.close(r));
});

const bytes = (...n) => Uint8Array.from(n);
const hex = (b) => Buffer.from(b).toString("hex");
const text = (s) => new TextEncoder().encode(s);

let n = 0;
/** Connect a client the way the app does: it decides what to send, we only carry bytes. */
async function connect(over = "tcp", opts = {}, { wait = true } = {}) {
  const client = new M.MqttClient({ clientId: `t-${process.pid}-${++n}`, keepAlive: 60, clean: true, subscriptions: [], ...opts });
  const log = { entries: [], status: undefined, info: undefined, closed: false };
  let write, close;
  const waiters = [];
  const handle = (step) => {
    for (const p of step.send) write(p);
    log.entries.push(...step.entries);
    if (step.status) log.status = step.status;
    if (step.info !== undefined) log.info = step.info;
    waiters.slice().forEach((w) => w());
  };
  if (over === "tcp") {
    const s = net.connect(tcpPort, "127.0.0.1");
    write = (p) => s.write(Buffer.from(p));
    close = () => s.destroy();
    s.on("data", (d) => handle(client.onBytes(new Uint8Array(d))));
    s.on("close", () => ((log.closed = true), waiters.slice().forEach((w) => w())));
    s.on("connect", () => handle(client.start()));
    s.on("error", () => {});
  } else {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/mqtt`, ["mqtt"]);
    write = (p) => ws.send(p);
    close = () => ws.terminate();
    ws.on("message", (d, isBinary) => isBinary && handle(client.onBytes(new Uint8Array(d))));
    ws.on("close", () => ((log.closed = true), waiters.slice().forEach((w) => w())));
    ws.on("open", () => handle(client.start()));
    ws.on("error", () => {});
  }
  const until = (pred, what = "condition", ms = 3000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}; log: ${JSON.stringify(log)}`)), ms);
      const check = () => {
        if (pred()) (clearTimeout(t), waiters.splice(waiters.indexOf(check), 1), resolve());
      };
      waiters.push(check);
      check();
    });
  const c = { client, log, until, close, handle, find: (re) => log.entries.find((e) => re.test(e.label)), all: (re) => log.entries.filter((e) => re.test(e.label)) };
  if (wait) await until(() => log.status === "open", "the connection");
  return c;
}

test("packets are encoded exactly as the MQTT 3.1.1 spec lays them out", () => {
  assert.equal(hex(M.encodeConnect({ clientId: "a", keepAlive: 60, clean: true })), "100d00044d5154540402003c000161");
  assert.equal(hex(M.encodeConnect({ clientId: "a", keepAlive: 10, clean: false, username: "u", password: "p" })), "1013" + "00044d51545404c0000a" + "000161" + "000175" + "000170");
  const will = M.encodeConnect({ clientId: "a", keepAlive: 10, clean: true, will: { topic: "w", payload: text("x"), qos: 1, retain: true } });
  assert.equal(hex(will), "1013" + "00044d515454042e000a" + "000161" + "000177" + "000178", "will flag, will QoS 1, will retain, clean session");
  assert.equal(hex(M.encodePublish({ topic: "a/b", payload: text("hi"), qos: 0, retain: false })), "300700036" + "12f62" + "6869");
  assert.equal(hex(M.encodePublish({ topic: "a", payload: text("x"), qos: 1, retain: true, id: 7 })), "33" + "06" + "0001" + "61" + "0007" + "78");
  assert.equal(hex(M.encodePublish({ topic: "a", payload: text("x"), qos: 2, retain: false, dup: true, id: 300 })), "3c" + "06" + "000161" + "012c" + "78");
  assert.equal(hex(M.encodeSubscribe(1, [{ topic: "a", qos: 1 }])), "8206" + "0001" + "000161" + "01");
  assert.equal(hex(M.encodeUnsubscribe(2, ["a", "b"])), "a208" + "0002" + "000161" + "000162");
  assert.equal(hex(M.encodeAckPacket(4, 258)), "40020102");
  assert.equal(hex(M.encodePubrel(5)), "62020005");
  assert.equal(hex(M.PINGREQ), "c000");
  assert.equal(hex(M.DISCONNECT), "e000");
});

test("the reader cuts a byte stream into packets wherever it is split, and reads long lengths", () => {
  const long = M.encodePublish({ topic: "t", payload: new Uint8Array(300).fill(65), qos: 0, retain: false });
  assert.equal(long[1] & 0x80, 0x80, "300 bytes need a two-byte length");
  const stream = M.concat([M.encodeAckPacket(4, 9), long, M.encodePublish({ topic: "u", payload: text("z"), qos: 1, retain: true, id: 3 })]);
  const byOne = new M.PacketReader();
  const got = [];
  for (const b of stream) got.push(...byOne.push(Uint8Array.of(b)));
  const whole = new M.PacketReader().push(stream);
  assert.deepEqual(got.map((p) => p.type), ["puback", "publish", "publish"]);
  assert.deepEqual(whole.map((p) => p.type), ["puback", "publish", "publish"]);
  assert.equal(got[1].payload.length, 300);
  assert.deepEqual([got[2].topic, got[2].qos, got[2].retain, got[2].id], ["u", 1, true, 3]);
  const bad = new M.PacketReader().push(Uint8Array.of(0x30, 0xff, 0xff, 0xff, 0xff, 0x01));
  assert.equal(bad[0].type, "malformed");
});

test("addresses, topics and payloads are checked before anything is sent", () => {
  assert.deepEqual(M.mqttTarget("broker.example.com"), { transport: "tcp", host: "broker.example.com", port: 1883, url: "broker.example.com" });
  assert.deepEqual(M.mqttTarget("mqtt://10.0.0.5:1999"), { transport: "tcp", host: "10.0.0.5", port: 1999, url: "mqtt://10.0.0.5:1999" });
  assert.deepEqual(M.mqttTarget("mqtts://b.io"), { transport: "tls", host: "b.io", port: 8883, url: "mqtts://b.io" });
  assert.equal(M.mqttTarget("ssl://b.io:1").port, 1);
  assert.deepEqual(M.mqttTarget("wss://b.io/mqtt"), { transport: "ws", host: "b.io", port: 443, url: "wss://b.io/mqtt" });
  assert.equal(M.mqttTarget("ws://b.io:8083/mqtt").port, 8083);
  assert.throws(() => M.mqttTarget("http://b.io"), /Use mqtt:\/\/, mqtts:\/\/, ws:\/\/ or wss:\/\//);
  assert.equal(M.topicNameError("a/b/c"), null);
  assert.match(M.topicNameError("a/+"), /wildcards/);
  assert.match(M.topicNameError("a/#"), /wildcards/);
  assert.match(M.topicNameError(""), /Give the topic/);
  for (const ok of ["#", "+", "a/#", "a/+/b", "+/+", "$SYS/#", "a"]) assert.equal(M.topicFilterError(ok), null, ok);
  for (const bad of ["a/#/b", "a#", "a/b#", "a+", "+a", ""]) assert.notEqual(M.topicFilterError(bad), null, bad);
  assert.deepEqual(Array.from(M.payloadBytes("48 65 6c 6c 6f", "hex").bytes), [72, 101, 108, 108, 111]);
  assert.deepEqual(Array.from(M.payloadBytes("0x48,0x65", "hex").bytes), [72, 101]);
  assert.match(M.payloadBytes("4g", "hex").error, /pairs of hex digits/);
  assert.match(M.payloadBytes("abc", "hex").error, /pairs of hex digits/);
  assert.match(M.payloadBytes("{oops", "json").error, /Not valid JSON/);
  assert.deepEqual(Array.from(M.payloadBytes("{\"a\":1}", "json").bytes), Array.from(text("{\"a\":1}")));
  assert.equal(M.payloadBytes("plain {not json", "text").bytes.length, 15);
  assert.equal(M.showPayload(text("hello")), "hello");
  assert.equal(M.showPayload(text('{"a":1,"b":[2]}')), '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  assert.equal(M.showPayload(bytes()), "(empty payload)");
  assert.equal(M.showPayload(bytes(0xff, 0x00, 0x10)), "ff 00 10\n(binary, 3 bytes)");
  assert.equal(M.fromBase64(M.toBase64(bytes(0, 1, 254, 255))).join(), "0,1,254,255");
});

for (const over of ["tcp", "ws"]) {
  test(`over ${over}: connect, subscribe with a wildcard and receive a published message`, async () => {
    const sub = await connect(over, { subscriptions: [{ topic: "sensors/+/temp", qos: 0 }] });
    assert.match(sub.log.info, /^t-\d+-\d+$/);
    await sub.until(() => sub.find(/^subscribed$/), "SUBACK");
    assert.match(sub.find(/^subscribed$/).text, /sensors\/\+\/temp \(QoS 0\)/);
    const pub = await connect(over);
    for (const [t, body] of [["sensors/a/temp", "21.5"], ["sensors/b/humidity", "40"], ["sensors/b/temp", '{"c":19}']]) {
      pub.handle(pub.client.publish(t, text(body), 0, false));
      // aedes behind ws's createWebSocketStream re-reads the first packet when frames arrive back to back (a quirk of
      // that test bridge, not of MQTT), so the frames are spaced out
      await new Promise((r) => setTimeout(r, 40));
    }
    await sub.until(() => sub.all(/^sensors\//).length === 2, "two matching messages");
    await new Promise((r) => setTimeout(r, 150));
    const got = sub.all(/^sensors\//);
    assert.equal(got.length, 2, "the humidity topic doesn't match the filter");
    assert.deepEqual(got.map((e) => e.label), ["sensors/a/temp · QoS 0", "sensors/b/temp · QoS 0"]);
    assert.equal(got[0].dir, "in");
    assert.equal(got[0].text, "21.5");
    assert.equal(got[1].text, '{\n  "c": 19\n}', "JSON is prettified");
    assert.equal(pub.log.entries.at(-1).dir, "out");
    sub.close();
    pub.close();
  });
}

test("QoS 1 is acknowledged by the broker, QoS 2 completes and the receiver gets it once", async () => {
  const sub = await connect("tcp", { subscriptions: [{ topic: "q/#", qos: 2 }] });
  await sub.until(() => sub.find(/^subscribed$/));
  const pub = await connect("tcp");
  pub.handle(pub.client.publish("q/one", text("a"), 1, false));
  pub.handle(pub.client.publish("q/two", text("b"), 2, false));
  await pub.until(() => pub.find(/^acknowledged · q\/one/) && pub.find(/^delivered · q\/two/), "both confirmations");
  assert.match(pub.find(/^acknowledged/).text, /QoS 1, \d+ ms/);
  assert.match(pub.find(/^delivered/).text, /exactly once \(QoS 2/);
  await sub.until(() => sub.all(/^q\//).length >= 2);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(sub.all(/^q\//).map((e) => e.label).sort(), ["q/one · QoS 1", "q/two · QoS 2"], "each message once");
  sub.close();
  pub.close();
});

test("retained messages arrive on subscribe and say so; an empty retained message clears them", async () => {
  const pub = await connect("tcp");
  pub.handle(pub.client.publish("ret/state", text("on"), 1, true));
  await pub.until(() => pub.find(/^acknowledged/));
  const late = await connect("tcp", { subscriptions: [{ topic: "ret/#", qos: 1 }] });
  await late.until(() => late.find(/^ret\/state/), "the retained message");
  assert.equal(late.find(/^ret\/state/).label, "ret/state · QoS 1 · retained");
  pub.handle(pub.client.publish("ret/state", new Uint8Array(0), 1, true));
  await pub.until(() => pub.all(/^acknowledged/).length === 2);
  const later = await connect("tcp", { subscriptions: [{ topic: "ret/#", qos: 0 }] });
  await later.until(() => later.find(/^subscribed$/));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(later.all(/^ret\//).length, 0, "cleared");
  for (const c of [pub, late, later]) c.close();
});

test("subscribing and unsubscribing while connected; a refused subscription is reported", async () => {
  const c = await connect("tcp");
  c.handle(c.client.subscribe("live/#", 1));
  await c.until(() => c.find(/^subscribed$/));
  const p = await connect("tcp");
  p.handle(p.client.publish("live/x", text("1"), 0, false));
  await c.until(() => c.find(/^live\/x/));
  c.handle(c.client.unsubscribe("live/#"));
  await c.until(() => c.find(/^unsubscribed$/));
  p.handle(p.client.publish("live/y", text("2"), 0, false));
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(c.find(/^live\/y/), undefined, "nothing after unsubscribing");
  c.handle(c.client.subscribe("denied/stuff", 0));
  await c.until(() => c.find(/^subscribe refused$/));
  assert.equal(c.find(/^subscribe refused$/).tone, "error");
  assert.throws(() => c.client.subscribe("a/#/b", 0), /# must be the whole last level/);
  assert.throws(() => c.client.publish("a/+", text("x"), 0, false), /wildcards/);
  c.close();
  p.close();
});

test("user name and password: accepted when right, refused with the reason when wrong", async () => {
  const ok = await connect("tcp", { username: "ada", password: "pw" });
  assert.match(ok.find(/^connect$/).text, /user ada/);
  ok.close();
  const bad = await connect("tcp", { username: "ada", password: "nope" }, { wait: false });
  await bad.until(() => bad.log.status === "error", "the refusal");
  assert.equal(bad.find(/^refused$/).text, "The broker refused the connection: wrong user name or password");
  assert.equal(bad.client.connected, false);
  assert.throws(() => bad.client.publish("a", text("x"), 0, false), /Not connected/);
  bad.close();
});

test("a will message is published when the connection drops without a goodbye", async () => {
  const watcher = await connect("tcp", { subscriptions: [{ topic: "status/#", qos: 1 }] });
  await watcher.until(() => watcher.find(/^subscribed$/));
  const mortal = await connect("tcp", { will: { topic: "status/mortal", payload: text("gone"), qos: 1, retain: false } });
  mortal.close(); // no DISCONNECT packet
  await watcher.until(() => watcher.find(/^status\/mortal/), "the will");
  assert.equal(watcher.find(/^status\/mortal/).text, "gone");
  const polite = await connect("tcp", { will: { topic: "status/polite", payload: text("gone"), qos: 0, retain: false } });
  for (const b of polite.client.disconnect()) polite.handle({ send: [b], entries: [] });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(watcher.find(/^status\/polite/), undefined, "a clean DISCONNECT discards the will");
  watcher.close();
});

test("a persistent session is resumed and says so", async () => {
  const id = `keep-${process.pid}`;
  const first = await connect("tcp", { clientId: id, clean: false, subscriptions: [{ topic: "keep/#", qos: 1 }] });
  await first.until(() => first.find(/^subscribed$/));
  assert.doesNotMatch(first.log.info, /resumed/);
  first.close();
  await new Promise((r) => setTimeout(r, 200));
  const second = await connect("tcp", { clientId: id, clean: false });
  assert.match(second.log.info, /session resumed/);
  assert.match(second.find(/^connected$/).text, /kept the previous session/);
  second.close();
});

test("keep-alive: pings go out when the connection is quiet, and the broker keeps us", async () => {
  const c = await connect("tcp", { keepAlive: 1 });
  const t0 = Date.now();
  while (Date.now() - t0 < 3200) {
    c.handle(c.client.tick());
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(c.log.closed, false, "still connected after 3 keep-alive periods");
  assert.equal(c.client.connected, true);
  c.close();

  const quiet = await connect("tcp", { keepAlive: 1 }); // never ticks, so never pings
  await quiet.until(() => quiet.log.closed, "the broker to drop it", 4000);
});

test("a broker that stops answering pings is noticed", async () => {
  let t = 1000;
  const client = new M.MqttClient({ clientId: "x", keepAlive: 10, clean: true, subscriptions: [] }, () => t);
  client.start();
  client.onBytes(Uint8Array.of(0x20, 0x02, 0x00, 0x00));
  assert.equal(client.connected, true);
  assert.equal(client.tick().send.length, 0, "not yet");
  t += 5000;
  assert.deepEqual(Array.from(client.tick().send[0]), [0xc0, 0], "a ping after half the keep-alive");
  t += 14000;
  assert.equal(client.tick().status, undefined, "within one and a half periods of the ping");
  t += 2000;
  const s = client.tick();
  assert.equal(s.status, "error");
  assert.match(s.entries[0].text, /has not answered a ping for 16 s/);
});

test("binary payloads show as hex and publish as bytes", async () => {
  const sub = await connect("tcp", { subscriptions: [{ topic: "bin/#", qos: 0 }] });
  await sub.until(() => sub.find(/^subscribed$/));
  const pub = await connect("tcp");
  pub.handle(pub.client.publish("bin/x", M.payloadBytes("ff 00 10", "hex").bytes, 0, false));
  await sub.until(() => sub.find(/^bin\/x/));
  assert.equal(sub.find(/^bin\/x/).text, "ff 00 10\n(binary, 3 bytes)");
  assert.equal(sub.find(/^bin\/x/).size, 3);
  sub.close();
  pub.close();
});

test("refusing a client that only speaks something older or newer is explained", () => {
  const client = new M.MqttClient({ clientId: "x", keepAlive: 10, clean: true, subscriptions: [] });
  const step = client.onBytes(Uint8Array.of(0x20, 0x02, 0x00, 0x01));
  assert.equal(step.status, "error");
  assert.match(step.entries[0].text, /doesn't support MQTT 3\.1\.1/);
});

test("an MQTT request is saved as type: mqtt and read back unchanged; defaults are not written", async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-mqtt-c-")), "collection.mjs");
  await build({
    entryPoints: [path.join(ROOT, "src/lib/collection.ts")], outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    alias: { "@tauri-apps/api/core": path.join(ROOT, "cli/shims/tauri-core.ts"), "@tauri-apps/plugin-dialog": path.join(ROOT, "cli/shims/plugin-dialog.ts"), "@tauri-apps/plugin-opener": path.join(ROOT, "cli/shims/plugin-opener.ts") },
  });
  const C = await import(out);
  const yaml = `name: Kitchen\ntype: mqtt\nurl: mqtts://broker.example.com\nmqtt:\n  keepAlive: 30\n  cleanSession: false\n  will:\n    topic: status/x\n    payload: offline\n    qos: 1\n    retain: true\n  topic: a/b\n  payload: '{"c": 1}'\n  qos: 2\n  retain: true\n  format: json\n  subscribe:\n    - topic: a/#\n    - topic: b/+\n      qos: 1\n`;
  const tab = C.parseRequest(yaml, "/x/k.req.yaml");
  assert.equal(tab.kind, "mqtt");
  const { subs, ...rest } = tab.mqtt;
  assert.deepEqual(rest, { clientId: "", keepAlive: 30, clean: false, willTopic: "status/x", willPayload: "offline", willQos: 1, willRetain: true, topic: "a/b", payload: '{"c": 1}', qos: 2, retain: true, format: "json" });
  assert.deepEqual(subs.map(({ id, ...s }) => s), [{ topic: "a/#", qos: 0 }, { topic: "b/+", qos: 1 }]);
  const again = C.serializeRequest(tab);
  assert.match(again, /^type: mqtt$/m);
  assert.doesNotMatch(again, /^method:/m);
  assert.equal(C.serializeRequest(C.parseRequest(again, "/x/k.req.yaml")), again, "saving what was read changes nothing");
  const plain = C.serializeRequest(C.parseRequest("name: P\ntype: mqtt\nurl: mqtt://b.io\n", "/x/p.req.yaml"));
  assert.doesNotMatch(plain, /keepAlive|cleanSession|qos|retain|format/, "defaults aren't written");
});
