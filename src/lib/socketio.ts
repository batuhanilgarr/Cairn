/**
 * A Socket.IO client (protocol v5, Engine.IO v4) over a plain WebSocket. It does not open the socket itself:
 * the app feeds it every text frame the server sends and sends what it returns, so it works with the same
 * `ws_connect` / `ws_send` pair as a WebSocket request and can be tested without a window.
 *
 * Supported: the WebSocket transport, namespaces, the auth payload, events in both directions, acknowledgements
 * in both directions, pings. Not supported: long-polling-only servers, binary attachments (they are listed but not
 * decoded), Socket.IO v2 servers (EIO=3).
 */
import type { StreamEntry, StreamStatus } from "./stream";

export type SioEntry = Omit<StreamEntry, "n" | "at">;
export type SioStep = { send: string[]; entries: SioEntry[]; status?: StreamStatus; info?: string };

export const DEFAULT_SIO_PATH = "/socket.io/";

/** "" and "/" are the main namespace; "admin" means "/admin". */
export function normalizeNamespace(ns: string): string {
  const t = ns.trim();
  if (!t || t === "/") return "/";
  return t.startsWith("/") ? t : "/" + t;
}

/**
 * The WebSocket address and namespace for what the user typed, the way socket.io-client reads it: the origin picks the
 * server, a path in the address is the namespace unless the namespace is given separately, and the Socket.IO path
 * (default /socket.io/) is where the engine lives.
 */
export function sioTarget(address: string, namespaceField: string, pathField: string): { url: string; namespace: string } {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : "http://" + address);
  } catch {
    throw new Error(`Not a valid address: ${address}`);
  }
  const secure = u.protocol === "https:" || u.protocol === "wss:";
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) throw new Error(`Use an http(s):// or ws(s):// address, not ${u.protocol}//`);
  const fromPath = u.pathname !== "/" ? u.pathname.replace(/\/+$/, "") : "";
  const namespace = normalizeNamespace(namespaceField.trim() ? namespaceField : fromPath);
  let path = pathField.trim() || DEFAULT_SIO_PATH;
  if (!path.startsWith("/")) path = "/" + path;
  if (!path.endsWith("/")) path += "/";
  const query = new URLSearchParams(u.search);
  query.set("EIO", "4");
  query.set("transport", "websocket");
  return { url: `${secure ? "wss" : "ws"}://${u.host}${path}?${query.toString()}`, namespace };
}

/** Empty is fine; otherwise the auth payload has to be a JSON object. Returns a message when it is not. */
export function sioAuthError(auth: string): string | null {
  if (!auth.trim()) return null;
  try {
    const v = JSON.parse(auth);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? null : "The auth payload must be a JSON object, like {\"token\": \"…\"}";
  } catch (e) {
    return `The auth payload isn't valid JSON: ${(e as Error).message}`;
  }
}

/** The arguments of an emit: empty means none, otherwise a JSON array whose items are the arguments. */
export function parseSioArgs(text: string): { args: unknown[] } | { error: string } {
  if (!text.trim()) return { args: [] };
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? { args: v } : { error: "Write the arguments as a JSON array: each item is one argument, e.g. [{\"text\": \"hi\"}]" };
  } catch (e) {
    return { error: `Not valid JSON: ${(e as Error).message}` };
  }
}

/* ------------------------------ packets ------------------------------ */

export type SioPacket = { type: number; namespace: string; id?: number; attachments?: number; data?: unknown; error?: string };

export const SIO = { CONNECT: 0, DISCONNECT: 1, EVENT: 2, ACK: 3, CONNECT_ERROR: 4, BINARY_EVENT: 5, BINARY_ACK: 6 } as const;

/** Decode one Socket.IO packet (the text after Engine.IO's "4"). */
export function parseSioPacket(s: string): SioPacket {
  let i = 0;
  const type = s.charCodeAt(0) - 48;
  if (!(type >= 0 && type <= 6)) return { type: -1, namespace: "/", error: `Unknown packet type "${s[0] ?? ""}"` };
  i++;
  const p: SioPacket = { type, namespace: "/" };
  if (type === SIO.BINARY_EVENT || type === SIO.BINARY_ACK) {
    const dash = s.indexOf("-", i);
    if (dash < 0) return { ...p, error: "A binary packet without an attachment count" };
    p.attachments = Number(s.slice(i, dash));
    i = dash + 1;
  }
  if (s[i] === "/") {
    const comma = s.indexOf(",", i);
    p.namespace = comma < 0 ? s.slice(i) : s.slice(i, comma);
    i = comma < 0 ? s.length : comma + 1;
  }
  let digits = "";
  while (i < s.length && s[i] >= "0" && s[i] <= "9") digits += s[i++];
  if (digits) p.id = Number(digits);
  const rest = s.slice(i);
  if (rest) {
    try {
      p.data = JSON.parse(rest);
    } catch (e) {
      p.error = `The packet has invalid JSON: ${(e as Error).message}`;
    }
  }
  return p;
}

const nsPart = (ns: string) => (ns === "/" ? "" : ns + ",");

export const encodeConnect = (ns: string, auth: string) => "40" + nsPart(ns) + (auth.trim() ? JSON.stringify(JSON.parse(auth)) : "");
export const encodeDisconnect = (ns: string) => "41" + nsPart(ns);
export const encodeEvent = (ns: string, event: string, args: unknown[], ackId?: number) => "42" + nsPart(ns) + (ackId ?? "") + JSON.stringify([event, ...args]);
export const encodeAck = (ns: string, id: number, args: unknown[]) => "43" + nsPart(ns) + id + JSON.stringify(args);

/** Arguments for display: one argument shows as itself, several as a list. */
export function showArgs(args: unknown[]): string {
  if (!args.length) return "(no arguments)";
  const one = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
  return args.length === 1 ? one(args[0]) : JSON.stringify(args, null, 2);
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

/* ------------------------------- client ------------------------------- */

export class SioClient {
  readonly namespace: string;
  private auth: string;
  private nextId = 1;
  private pending = new Map<number, { event: string; at: number }>();
  connected = false;
  /** True once the server's Engine.IO handshake has arrived. */
  private opened = false;
  sid = "";

  constructor(o: { namespace: string; auth: string }, private now: () => number = () => Date.now()) {
    this.namespace = normalizeNamespace(o.namespace);
    this.auth = o.auth;
  }

  /** What to do with one text frame from the server. */
  onText(frame: string): SioStep {
    const step: SioStep = { send: [], entries: [] };
    const kind = frame[0];
    const body = frame.slice(1);
    if (!this.opened && kind !== "0") {
      step.entries.push({ dir: "sys", label: "error", text: `The server's first message isn't a Socket.IO handshake (${JSON.stringify(frame.slice(0, 40))}). Is this a Socket.IO server (protocol v4, WebSocket transport)?`, tone: "error" });
      step.status = "error";
      return step;
    }
    switch (kind) {
      case "0": {
        let open: any;
        try {
          open = JSON.parse(body);
        } catch {
          step.entries.push({ dir: "sys", label: "error", text: "The server's first message isn't a Socket.IO handshake. Is this a Socket.IO server (protocol v4, WebSocket transport)?", tone: "error" });
          step.status = "error";
          return step;
        }
        this.opened = true;
        this.sid = String(open?.sid ?? "");
        const every = Number(open?.pingInterval);
        step.entries.push({ dir: "sys", label: "engine.io", text: `Handshake done${this.sid ? ` (session ${this.sid})` : ""}${Number.isFinite(every) ? `, the server pings every ${every / 1000} s` : ""}` });
        try {
          step.send.push(encodeConnect(this.namespace, this.auth));
        } catch (e) {
          step.entries.push({ dir: "sys", label: "error", text: `The auth payload isn't valid JSON: ${(e as Error).message}`, tone: "error" });
          step.status = "error";
        }
        return step;
      }
      case "1":
        this.connected = false;
        step.entries.push({ dir: "sys", label: "closed", text: "The server closed the connection" });
        step.status = "closed";
        return step;
      case "2":
        step.send.push("3" + body);
        return step;
      case "3":
      case "5":
      case "6":
        return step;
      case "4":
        return this.onPacket(parseSioPacket(body), body, step);
      default:
        step.entries.push({ dir: "sys", label: "warning", text: `Unknown Engine.IO packet: ${frame.slice(0, 60)}`, tone: "error" });
        return step;
    }
  }

  /** A binary WebSocket frame: only listed, never decoded. */
  onBinary(size: number): SioStep {
    return { send: [], entries: [{ dir: "in", label: "binary attachment", text: `${size} bytes (binary attachments aren't decoded)`, size }] };
  }

  private onPacket(p: SioPacket, raw: string, step: SioStep): SioStep {
    if (p.error) {
      step.entries.push({ dir: "sys", label: "warning", text: `${p.error}: ${raw.slice(0, 80)}`, tone: "error" });
      return step;
    }
    const ns = p.namespace === "/" ? "" : ` on ${p.namespace}`;
    switch (p.type) {
      case SIO.CONNECT: {
        this.connected = true;
        const sid = (p.data as any)?.sid;
        step.status = "open";
        step.info = `${this.namespace}${sid ? ` · ${sid}` : ""}`;
        step.entries.push({ dir: "sys", label: "connected", text: `Namespace ${p.namespace}${sid ? `, socket id ${sid}` : ""}` });
        return step;
      }
      case SIO.CONNECT_ERROR: {
        const d: any = p.data;
        const msg = typeof d === "string" ? d : d?.message ?? JSON.stringify(d);
        step.status = "error";
        step.entries.push({ dir: "sys", label: "refused", text: `The server refused ${p.namespace}: ${msg}${d?.data !== undefined ? `\n${JSON.stringify(d.data, null, 2)}` : ""}`, tone: "error" });
        return step;
      }
      case SIO.DISCONNECT:
        this.connected = false;
        step.status = "closed";
        step.entries.push({ dir: "sys", label: "disconnected", text: `The server disconnected this socket${ns}` });
        return step;
      case SIO.EVENT:
      case SIO.BINARY_EVENT: {
        const list = Array.isArray(p.data) ? p.data : [];
        const [event, ...args] = list;
        const text = showArgs(args);
        step.entries.push({ dir: "in", label: String(event ?? "(no event name)"), text: p.type === SIO.BINARY_EVENT ? `${text}\n(${p.attachments ?? 0} binary attachment${p.attachments === 1 ? "" : "s"} follow, not decoded)` : text, size: bytes(text) });
        if (p.id !== undefined) {
          // the server wants an answer: we have none to give, so say so and keep the exchange from hanging
          step.send.push(encodeAck(this.namespace, p.id, []));
          step.entries.push({ dir: "out", label: `ack ${p.id}`, text: "(empty acknowledgement, sent automatically)" });
        }
        return step;
      }
      case SIO.ACK:
      case SIO.BINARY_ACK: {
        const sent = p.id !== undefined ? this.pending.get(p.id) : undefined;
        if (p.id !== undefined) this.pending.delete(p.id);
        const args = Array.isArray(p.data) ? p.data : [];
        const text = showArgs(args);
        step.entries.push({ dir: "in", label: sent ? `ack · ${sent.event}` : `ack ${p.id ?? ""}`.trim(), text: sent ? `${text}\n(${this.now() - sent.at} ms after the emit)` : text, size: bytes(text) });
        return step;
      }
      default:
        step.entries.push({ dir: "sys", label: "warning", text: `Unknown Socket.IO packet type ${p.type}`, tone: "error" });
        return step;
    }
  }

  /** The frame for an event, and what to log; with `ack` the server's answer is matched to it. */
  emit(event: string, args: unknown[], ack: boolean): { frame: string; entry: SioEntry } {
    if (!event.trim()) throw new Error("Give the event a name");
    if (!this.connected) throw new Error("Not connected to the namespace yet");
    const id = ack ? this.nextId++ : undefined;
    if (id !== undefined) this.pending.set(id, { event, at: this.now() });
    const text = showArgs(args);
    return { frame: encodeEvent(this.namespace, event, args, id), entry: { dir: "out", label: id !== undefined ? `${event} · wants ack` : event, text, size: bytes(text) } };
  }

  /** Frames to send before closing the socket. */
  disconnect(): string[] {
    const was = this.connected;
    this.connected = false;
    return was ? [encodeDisconnect(this.namespace)] : [];
  }
}
