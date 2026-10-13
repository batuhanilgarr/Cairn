import fs from "node:fs";
import path from "node:path";
import { Agent, ProxyAgent, EnvHttpProxyAgent, FormData, Headers, fetch, type Dispatcher } from "undici";
import { CookieJar } from "tough-cookie";

/** The same request/response shape the app's Rust `send_request` uses, implemented on Node's fetch. */
type Spec = {
  method: string;
  url: string;
  headers: [string, string][];
  body?: string | null;
  multipart?: { name: string; value: string; file: boolean; contentType?: string }[] | null;
  bodyFile?: string | null;
  timeoutMs?: number;
  insecure?: boolean;
  followRedirects?: boolean;
  network?: {
    proxyMode?: string;
    proxyUrl?: string;
    noProxy?: string;
    caCert?: string;
    clientCert?: string;
    clientKey?: string;
    userAgent?: string;
    cookiesDisabled?: boolean;
  };
};

const jar = new CookieJar();
const agents = new Map<string, Dispatcher>();

function dispatcherFor(spec: Spec): Dispatcher {
  const n = spec.network ?? {};
  const key = JSON.stringify([spec.insecure, n.proxyMode, n.proxyUrl, n.caCert, n.clientCert, n.clientKey]);
  let d = agents.get(key);
  if (d) return d;
  const connect: Record<string, unknown> = {};
  if (spec.insecure) connect.rejectUnauthorized = false;
  if (n.caCert) connect.ca = fs.readFileSync(n.caCert);
  if (n.clientCert) {
    connect.cert = fs.readFileSync(n.clientCert);
    connect.key = fs.readFileSync(n.clientKey || n.clientCert);
  }
  if (n.proxyMode === "custom" && n.proxyUrl) d = new ProxyAgent({ uri: n.proxyUrl, requestTls: connect as never, proxyTls: connect as never });
  else if (n.proxyMode === "none") d = new Agent({ connect: connect as never });
  else d = new EnvHttpProxyAgent({ connect: connect as never });
  agents.set(key, d);
  return d;
}

function isBinary(contentType: string, bytes: Buffer): boolean {
  const ct = contentType.toLowerCase();
  if (/^text\/|json|xml|javascript|x-www-form-urlencoded|graphql|yaml|csv/.test(ct)) return false;
  if (/^(image|audio|video|font)\/|pdf|octet-stream|zip|protobuf|msgpack/.test(ct)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

export async function sendHttp(spec: Spec) {
  const n = spec.network ?? {};
  const started = performance.now();
  const dispatcher = dispatcherFor(spec);
  let url = spec.url;
  let method = spec.method.toUpperCase();
  let body: string | Buffer | FormData | undefined = spec.body || undefined;
  const headers = new Headers();
  for (const [k, v] of spec.headers) if (k.trim()) headers.append(k, v);
  if (spec.multipart) {
    const form = new FormData();
    for (const p of spec.multipart) {
      if (p.file) {
        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(p.value);
        } catch (e: any) {
          throw new Error(`Can't read file for field "${p.name}" (${p.value}): ${e.message}`);
        }
        form.append(p.name, new Blob([bytes], { type: p.contentType || "application/octet-stream" }), path.basename(p.value));
      } else {
        form.append(p.name, p.contentType ? new Blob([p.value], { type: p.contentType }) : p.value);
      }
    }
    body = form;
    headers.delete("content-type"); // fetch adds the multipart boundary itself
  } else if (spec.bodyFile) {
    try {
      body = fs.readFileSync(spec.bodyFile);
    } catch (e: any) {
      throw new Error(`Can't read body file ${spec.bodyFile}: ${e.message}`);
    }
  }
  if (!headers.has("user-agent")) headers.set("user-agent", n.userAgent || "Reqnest-CLI/0.2.2");

  let res!: Awaited<ReturnType<typeof fetch>>;
  let ttfb = 0;
  for (let hop = 0; ; hop++) {
    if (!n.cookiesDisabled && !headers.has("cookie")) {
      const c = await jar.getCookieString(url);
      if (c) headers.set("cookie", c);
    }
    try {
      res = await fetch(url, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        redirect: "manual",
        dispatcher,
        signal: AbortSignal.timeout(spec.timeoutMs ?? 30_000),
      });
    } catch (e: any) {
      const cause = e?.cause?.message ?? e?.cause?.code;
      throw new Error(cause ? `${e.message}: ${cause}` : String(e?.message ?? e));
    }
    if (hop === 0) ttfb = performance.now() - started;
    if (!n.cookiesDisabled) for (const c of res.headers.getSetCookie()) await jar.setCookie(c, url).catch(() => {});
    const loc = res.headers.get("location");
    if (spec.followRedirects !== false && loc && [301, 302, 303, 307, 308].includes(res.status) && hop < 10) {
      url = new URL(loc, url).toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
        headers.delete("content-length");
      }
      headers.delete("cookie");
      await res.arrayBuffer().catch(() => {});
      continue;
    }
    break;
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  const timeMs = Math.round(performance.now() - started);
  const contentType = res.headers.get("content-type") ?? "";
  const binary = bytes.length > 0 && isBinary(contentType, bytes);
  const outHeaders: [string, string][] = [];
  res.headers.forEach((v, k) => {
    if (k !== "set-cookie") outHeaders.push([k, v]);
  });
  for (const c of res.headers.getSetCookie()) outHeaders.push(["set-cookie", c]);
  return {
    status: res.status,
    statusText: res.statusText,
    headers: outHeaders,
    body: binary ? "" : bytes.toString("utf8"),
    bodyBase64: binary ? bytes.toString("base64") : null,
    contentType,
    sizeBytes: bytes.length,
    timeMs,
    ttfbMs: Math.round(ttfb),
    httpVersion: "HTTP/1.1",
  };
}
