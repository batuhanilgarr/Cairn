/**
 * An MQTT 3.1.1 client that does no I/O: it turns bytes from the broker into log entries and replies, and the app
 * carries the bytes (over TCP, TLS or a WebSocket). That keeps it testable against a real broker without a window.
 *
 * Supported: CONNECT with user name, password, will and clean session, QoS 0/1/2 in both directions, retained
 * messages, SUBSCRIBE/UNSUBSCRIBE with wildcards, keep-alive pings. Not supported: MQTT 5 (a broker that only speaks 5
 * refuses the connection) and automatic reconnecting.
 */
import type { StreamEntry, StreamStatus } from "./stream";

export type MqttEntry = Omit<StreamEntry, "n" | "at">;
export type MqttStep = { send: Uint8Array[]; entries: MqttEntry[]; status?: StreamStatus; info?: string };
export type Qos = 0 | 1 | 2;

const enc = new TextEncoder();

/* ------------------------------- addresses ------------------------------- */

export type MqttTarget = { transport: "tcp" | "tls" | "ws"; host: string; port: number; url: string };

/** mqtt://host[:1883] and tcp:// are plain TCP, mqtts://host[:8883] and ssl:// are TLS, ws:// and wss:// are WebSocket. */
export function mqttTarget(address: string): MqttTarget {
  const raw = address.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "mqtt://" + raw;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid address: ${address}`);
  }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error("The address has no host");
  if (scheme === "mqtt" || scheme === "tcp") return { transport: "tcp", host, port: u.port ? Number(u.port) : 1883, url: raw };
  if (scheme === "mqtts" || scheme === "ssl" || scheme === "tls") return { transport: "tls", host, port: u.port ? Number(u.port) : 8883, url: raw };
  if (scheme === "ws" || scheme === "wss") return { transport: "ws", host, port: u.port ? Number(u.port) : scheme === "wss" ? 443 : 80, url: withScheme };
  throw new Error(`Use mqtt://, mqtts://, ws:// or wss://, not ${scheme}://`);
}

/* -------------------------------- topics -------------------------------- */

/** A topic you publish to: no wildcards. Returns a message when it is not valid. */
export function topicNameError(t: string): string | null {
  if (!t) return "Give the topic a name";
  if (t.includes("\0")) return "A topic can't contain a null character";
  if (/[#+]/.test(t)) return "A topic you publish to can't contain the wildcards # or +";
  if (enc.encode(t).length > 65535) return "The topic is too long";
  return null;
}

/** A topic filter you subscribe to: + is one level, # is the rest and only valid at the end. */
export function topicFilterError(t: string): string | null {
  if (!t) return "Give the topic filter";
  if (t.includes("\0")) return "A topic can't contain a null character";
  const levels = t.split("/");
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i];
    if (l.includes("#") && (l !== "#" || i !== levels.length - 1)) return "# must be the whole last level, like sensors/#";
    if (l.includes("+") && l !== "+") return "+ must be a whole level, like sensors/+/temp";
  }
  return null;
}

/* ---------------------------------- bytes ---------------------------------- */

const str = (s: string) => {
  const b = enc.encode(s);
  return concat([u16(b.length), b]);
};
const bin = (b: Uint8Array) => concat([u16(b.length), b]);
const u16 = (n: number) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let i = 0;
  for (const p of parts) (out.set(p, i), (i += p.length));
  return out;
}
function varint(n: number): Uint8Array {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Uint8Array.from(out);
}
const packet = (type: number, flags: number, body: Uint8Array) => concat([Uint8Array.of((type << 4) | flags), varint(body.length), body]);

export const toBase64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/* -------------------------------- packets -------------------------------- */

export type Will = { topic: string; payload: Uint8Array; qos: Qos; retain: boolean };
export type ConnectOptions = { clientId: string; keepAlive: number; clean: boolean; username?: string; password?: string; will?: Will };

export function encodeConnect(o: ConnectOptions): Uint8Array {
  let flags = 0;
  if (o.clean) flags |= 0x02;
  if (o.will) flags |= 0x04 | (o.will.qos << 3) | (o.will.retain ? 0x20 : 0);
  if (o.username !== undefined && o.username !== "") flags |= 0x80;
  if (o.password !== undefined && o.password !== "") flags |= 0x40;
  const payload = [str(o.clientId)];
  if (o.will) payload.push(str(o.will.topic), bin(o.will.payload));
  if (flags & 0x80) payload.push(str(o.username!));
  if (flags & 0x40) payload.push(bin(enc.encode(o.password!)));
  return packet(1, 0, concat([str("MQTT"), Uint8Array.of(4, flags), u16(o.keepAlive), ...payload]));
}

export const encodePublish = (p: { topic: string; payload: Uint8Array; qos: Qos; retain: boolean; dup?: boolean; id?: number }) =>
  packet(3, (p.dup ? 8 : 0) | (p.qos << 1) | (p.retain ? 1 : 0), concat([str(p.topic), ...(p.qos > 0 ? [u16(p.id!)] : []), p.payload]));
export const encodeAckPacket = (type: 4 | 5 | 7, id: number) => packet(type, 0, u16(id));
export const encodePubrel = (id: number) => packet(6, 2, u16(id));
export const encodeSubscribe = (id: number, subs: { topic: string; qos: Qos }[]) => packet(8, 2, concat([u16(id), ...subs.flatMap((s) => [str(s.topic), Uint8Array.of(s.qos)])]));
export const encodeUnsubscribe = (id: number, topics: string[]) => packet(10, 2, concat([u16(id), ...topics.map(str)]));
export const PINGREQ = Uint8Array.of(0xc0, 0);
export const DISCONNECT = Uint8Array.of(0xe0, 0);

export type Packet =
  | { type: "connack"; sessionPresent: boolean; code: number }
  | { type: "publish"; topic: string; payload: Uint8Array; qos: Qos; retain: boolean; dup: boolean; id?: number }
  | { type: "puback" | "pubrec" | "pubrel" | "pubcomp" | "unsuback"; id: number }
  | { type: "suback"; id: number; codes: number[] }
  | { type: "pingresp" }
  | { type: "unknown"; code: number }
  | { type: "malformed"; message: string };

/** Cuts a byte stream (TCP delivers it in arbitrary pieces) into MQTT packets and decodes them. */
export class PacketReader {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Packet[] {
    this.buf = this.buf.length ? concat([this.buf, chunk]) : chunk;
    const out: Packet[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      let len = 0;
      let mult = 1;
      let i = 1;
      let complete = false;
      for (; i < Math.min(this.buf.length, 5); i++) {
        len += (this.buf[i] & 0x7f) * mult;
        mult *= 128;
        if (!(this.buf[i] & 0x80)) {
          complete = true;
          i++;
          break;
        }
      }
      if (!complete) {
        if (this.buf.length >= 5) {
          out.push({ type: "malformed", message: "The broker sent a packet with an invalid length" });
          this.buf = new Uint8Array(0);
        }
        break;
      }
      if (this.buf.length < i + len) break;
      out.push(decode(this.buf[0], this.buf.subarray(i, i + len)));
      this.buf = this.buf.slice(i + len);
    }
    return out;
  }
}

function decode(head: number, b: Uint8Array): Packet {
  const type = head >> 4;
  const flags = head & 0x0f;
  const id = () => (b[0] << 8) | b[1];
  try {
    switch (type) {
      case 2:
        if (b.length < 2) throw new Error("short CONNACK");
        return { type: "connack", sessionPresent: !!(b[0] & 1), code: b[1] };
      case 3: {
        const qos = ((flags >> 1) & 3) as Qos;
        if (qos > 2) throw new Error("QoS 3");
        const tl = (b[0] << 8) | b[1];
        const topic = new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(2, 2 + tl));
        let at = 2 + tl;
        let pid: number | undefined;
        if (qos > 0) {
          pid = (b[at] << 8) | b[at + 1];
          at += 2;
        }
        if (at > b.length) throw new Error("short PUBLISH");
        return { type: "publish", topic, payload: b.slice(at), qos, retain: !!(flags & 1), dup: !!(flags & 8), id: pid };
      }
      case 4: return { type: "puback", id: id() };
      case 5: return { type: "pubrec", id: id() };
      case 6: return { type: "pubrel", id: id() };
      case 7: return { type: "pubcomp", id: id() };
      case 9: return { type: "suback", id: id(), codes: Array.from(b.subarray(2)) };
      case 11: return { type: "unsuback", id: id() };
      case 13: return { type: "pingresp" };
      default: return { type: "unknown", code: type };
    }
  } catch (e) {
    return { type: "malformed", message: `A packet from the broker could not be read (${(e as Error).message})` };
  }
}

/* ------------------------------ payload text ------------------------------ */

/** How a payload is shown: text (JSON prettified) when it is valid UTF-8, otherwise hex. */
export function showPayload(b: Uint8Array): string {
  if (!b.length) return "(empty payload)";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    const hex = Array.from(b.subarray(0, 512), (x) => x.toString(16).padStart(2, "0")).join(" ");
    return `${hex}${b.length > 512 ? " …" : ""}\n(binary, ${b.length} bytes)`;
  }
  const t = text.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not JSON after all */
    }
  }
  return text;
}

export type PayloadFormat = "text" | "json" | "hex";

/** The bytes to publish for what is in the composer, or a message when it can't be that format. */
export function payloadBytes(text: string, format: PayloadFormat): { bytes: Uint8Array } | { error: string } {
  if (format === "hex") {
    const h = text.replace(/0x/gi, "").replace(/[\s,:]/g, "");
    if (h.length % 2 || /[^0-9a-f]/i.test(h)) return { error: "Hex payloads are pairs of hex digits, like 48 65 6c 6c 6f" };
    return { bytes: Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16)) };
  }
  if (format === "json" && text.trim()) {
    try {
      JSON.parse(text);
    } catch (e) {
      return { error: `Not valid JSON: ${(e as Error).message}` };
    }
  }
  return { bytes: enc.encode(text) };
}

/* ---------------------------------- client ---------------------------------- */

const CONNACK_TEXT: Record<number, string> = {
  1: "the broker doesn't support MQTT 3.1.1 (a broker that only speaks MQTT 5 refuses this client)",
  2: "the client id was rejected",
  3: "the server is unavailable",
  4: "wrong user name or password",
  5: "not authorized",
};

export type MqttOptions = ConnectOptions & {
  /** Subscribed as soon as the broker accepts the connection. */
  subscriptions: { topic: string; qos: Qos }[];
};

export class MqttClient {
  connected = false;
  private reader = new PacketReader();
  private nextId = 1;
  private lastSent = 0;
  private pingSentAt = 0;
  private outPub = new Map<number, { topic: string; qos: Qos; at: number }>();
  private pendingSub = new Map<number, { topic: string; qos: Qos }[]>();
  private pendingUnsub = new Map<number, string[]>();
  private inQos2 = new Set<number>();

  constructor(private o: MqttOptions, private now: () => number = () => Date.now()) {}

  private sent(p: Uint8Array, step: MqttStep) {
    this.lastSent = this.now();
    step.send.push(p);
  }
  private id(inUse: (n: number) => boolean) {
    for (let i = 0; i < 65535; i++) {
      const n = this.nextId;
      this.nextId = this.nextId >= 65535 ? 1 : this.nextId + 1;
      if (!inUse(n)) return n;
    }
    throw new Error("Too many messages are waiting for the broker");
  }
  private busy = (n: number) => this.outPub.has(n) || this.pendingSub.has(n) || this.pendingUnsub.has(n);

  /** The CONNECT packet; send it as soon as the transport is open. */
  start(): MqttStep {
    const step: MqttStep = { send: [], entries: [] };
    this.sent(encodeConnect(this.o), step);
    step.entries.push({ dir: "out", label: "connect", text: `Client id ${this.o.clientId}, keep-alive ${this.o.keepAlive} s, ${this.o.clean ? "clean" : "persistent"} session${this.o.username ? `, user ${this.o.username}` : ""}${this.o.will ? `, will on ${this.o.will.topic}` : ""}` });
    return step;
  }

  onBytes(bytes: Uint8Array): MqttStep {
    const step: MqttStep = { send: [], entries: [] };
    for (const p of this.reader.push(bytes)) this.onPacket(p, step);
    return step;
  }

  private onPacket(p: Packet, step: MqttStep) {
    switch (p.type) {
      case "connack":
        if (p.code !== 0) {
          step.status = "error";
          step.entries.push({ dir: "sys", label: "refused", text: `The broker refused the connection: ${CONNACK_TEXT[p.code] ?? `return code ${p.code}`}`, tone: "error" });
          return;
        }
        this.connected = true;
        step.status = "open";
        step.info = `${this.o.clientId}${p.sessionPresent ? " · session resumed" : ""}`;
        step.entries.push({ dir: "sys", label: "connected", text: `Connected as ${this.o.clientId}${p.sessionPresent ? " (the broker kept the previous session)" : ""}` });
        if (this.o.subscriptions.length) this.doSubscribe(this.o.subscriptions, step);
        return;
      case "publish": {
        const text = showPayload(p.payload);
        const meta = [`QoS ${p.qos}`, p.retain ? "retained" : "", p.dup ? "duplicate" : ""].filter(Boolean).join(" · ");
        const dupe = p.qos === 2 && p.id !== undefined && this.inQos2.has(p.id);
        if (!dupe) step.entries.push({ dir: "in", label: `${p.topic} · ${meta}`, text, size: p.payload.length });
        if (p.qos === 1 && p.id !== undefined) this.sent(encodeAckPacket(4, p.id), step);
        if (p.qos === 2 && p.id !== undefined) {
          this.inQos2.add(p.id);
          this.sent(encodeAckPacket(5, p.id), step);
        }
        return;
      }
      case "pubrel":
        this.inQos2.delete(p.id);
        this.sent(encodeAckPacket(7, p.id), step);
        return;
      case "puback": {
        const m = this.outPub.get(p.id);
        this.outPub.delete(p.id);
        if (m) step.entries.push({ dir: "sys", label: `acknowledged · ${m.topic}`, text: `The broker has the message (QoS 1, ${this.now() - m.at} ms)` });
        return;
      }
      case "pubrec": {
        const m = this.outPub.get(p.id);
        if (m) this.sent(encodePubrel(p.id), step);
        return;
      }
      case "pubcomp": {
        const m = this.outPub.get(p.id);
        this.outPub.delete(p.id);
        if (m) step.entries.push({ dir: "sys", label: `delivered · ${m.topic}`, text: `Delivered exactly once (QoS 2, ${this.now() - m.at} ms)` });
        return;
      }
      case "suback": {
        const subs = this.pendingSub.get(p.id) ?? [];
        this.pendingSub.delete(p.id);
        subs.forEach((s, i) => {
          const code = p.codes[i];
          if (code === undefined || code === 0x80) step.entries.push({ dir: "sys", label: "subscribe refused", text: `The broker refused ${s.topic}`, tone: "error" });
          else step.entries.push({ dir: "sys", label: "subscribed", text: `${s.topic} (QoS ${code}${code < s.qos ? `, asked for ${s.qos}` : ""})` });
        });
        return;
      }
      case "unsuback": {
        const topics = this.pendingUnsub.get(p.id) ?? [];
        this.pendingUnsub.delete(p.id);
        for (const t of topics) step.entries.push({ dir: "sys", label: "unsubscribed", text: t });
        return;
      }
      case "pingresp":
        this.pingSentAt = 0;
        return;
      case "malformed":
        step.entries.push({ dir: "sys", label: "error", text: p.message, tone: "error" });
        step.status = "error";
        return;
      case "unknown":
        step.entries.push({ dir: "sys", label: "warning", text: `An MQTT packet of type ${p.code} was not expected here`, tone: "error" });
        return;
    }
  }

  private doSubscribe(subs: { topic: string; qos: Qos }[], step: MqttStep) {
    const id = this.id(this.busy);
    this.pendingSub.set(id, subs);
    this.sent(encodeSubscribe(id, subs), step);
    for (const s of subs) step.entries.push({ dir: "out", label: "subscribe", text: `${s.topic} (QoS ${s.qos})` });
  }

  subscribe(topic: string, qos: Qos): MqttStep {
    if (!this.connected) throw new Error("Not connected to the broker yet");
    const bad = topicFilterError(topic);
    if (bad) throw new Error(bad);
    const step: MqttStep = { send: [], entries: [] };
    this.doSubscribe([{ topic, qos }], step);
    return step;
  }

  unsubscribe(topic: string): MqttStep {
    if (!this.connected) throw new Error("Not connected to the broker yet");
    const step: MqttStep = { send: [], entries: [] };
    const id = this.id(this.busy);
    this.pendingUnsub.set(id, [topic]);
    this.sent(encodeUnsubscribe(id, [topic]), step);
    step.entries.push({ dir: "out", label: "unsubscribe", text: topic });
    return step;
  }

  publish(topic: string, payload: Uint8Array, qos: Qos, retain: boolean): MqttStep {
    if (!this.connected) throw new Error("Not connected to the broker yet");
    const bad = topicNameError(topic);
    if (bad) throw new Error(bad);
    const step: MqttStep = { send: [], entries: [] };
    let id: number | undefined;
    if (qos > 0) {
      id = this.id(this.busy);
      this.outPub.set(id, { topic, qos, at: this.now() });
    }
    this.sent(encodePublish({ topic, payload, qos, retain, id }), step);
    step.entries.push({ dir: "out", label: `${topic} · QoS ${qos}${retain ? " · retained" : ""}`, text: showPayload(payload), size: payload.length });
    return step;
  }

  /** Call about once a second: sends a ping when the connection has been quiet, and notices a broker that stopped answering. */
  tick(): MqttStep {
    const step: MqttStep = { send: [], entries: [] };
    const ka = this.o.keepAlive * 1000;
    if (!this.connected || !ka) return step;
    const t = this.now();
    if (this.pingSentAt && t - this.pingSentAt > ka * 1.5) {
      this.connected = false;
      step.status = "error";
      step.entries.push({ dir: "sys", label: "error", text: `The broker has not answered a ping for ${Math.round((t - this.pingSentAt) / 1000)} s`, tone: "error" });
      return step;
    }
    if (!this.pingSentAt && t - this.lastSent >= ka / 2) {
      this.pingSentAt = t;
      this.sent(PINGREQ, step);
    }
    return step;
  }

  disconnect(): Uint8Array[] {
    const was = this.connected;
    this.connected = false;
    return was ? [DISCONNECT] : [];
  }
}
