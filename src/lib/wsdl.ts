import type { ImportResult, ImportedRequest } from "./openapi";
import type { RequestTab } from "./types";
import { emptyKV, newTab } from "./util";
import { childrenOf, escapeXml, firstChild, parseXml, qname, type XNode } from "./xml";

/**
 * WSDL 1.1 (SOAP 1.1 and 1.2 bindings) -> Cairn requests. Every operation of every SOAP port becomes a POST
 * with a ready-to-edit SOAP envelope built from the schema (document/literal and rpc/literal), the right
 * Content-Type and SOAPAction, and the endpoint address from the service's port.
 */
const WSDL = "http://schemas.xmlsoap.org/wsdl/";
const SOAP11 = "http://schemas.xmlsoap.org/wsdl/soap/";
const SOAP12 = "http://schemas.xmlsoap.org/wsdl/soap12/";
const WSDL2 = "http://www.w3.org/ns/wsdl";
const XSD = "http://www.w3.org/2001/XMLSchema";
const ENV11 = "http://schemas.xmlsoap.org/soap/envelope/";
const ENV12 = "http://www.w3.org/2003/05/soap-envelope";

export type WsdlOptions = {
  /** Fetch a document the WSDL imports (a schema or another WSDL). Return null when it can't be read. */
  resolve?: (location: string) => Promise<string | null>;
};

type Doc = { root: XNode; location: string };
const key = (ns: string, local: string) => `{${ns}}${local}`;

/** True for text that looks like a WSDL document. */
export function isWsdl(text: string): boolean {
  const head = text.slice(0, 4000);
  return /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<([\w.-]+:)?(definitions|description)\b/.test(head) && /wsdl|schemas\.xmlsoap\.org/.test(head);
}

/* --------------------------------- loading -------------------------------- */

async function collect(text: string, location: string, opts: WsdlOptions, notes: string[]): Promise<{ wsdls: Doc[]; schemas: XNode[] }> {
  const wsdls: Doc[] = [];
  const schemas: XNode[] = [];
  const seen = new Set<string>([location]);
  const queue: { node: XNode; location: string; kind: "wsdl" | "schema" }[] = [{ node: parseXml(text), location, kind: "wsdl" }];
  const base = (loc: string, rel: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return rel;
    if (/^https?:\/\//i.test(loc)) {
      try {
        return new URL(rel, loc).toString();
      } catch {
        return rel;
      }
    }
    if (!loc) return rel;
    // a file path: resolve "../x" and "./x" against the folder of the importing file
    const parts = (rel.startsWith("/") ? rel : `${loc.slice(0, loc.lastIndexOf("/") + 1)}${rel}`).split("/");
    const out: string[] = [];
    for (const p of parts) {
      if (p === "..") out.pop();
      else if (p !== ".") out.push(p);
    }
    return out.join("/");
  };
  const follow = async (parent: XNode, loc: string, rel: string, kind: "wsdl" | "schema") => {
    const target = base(loc, rel);
    if (seen.has(target)) return;
    seen.add(target);
    const got = opts.resolve ? await opts.resolve(target).catch(() => null) : null;
    if (got === null) return void notes.push(`Couldn't load ${rel}: the types it defines are missing from the sample envelopes.`);
    try {
      queue.push({ node: parseXml(got), location: target, kind });
    } catch (e) {
      notes.push(`${rel}: ${(e as Error).message}`);
    }
    void parent;
  };
  while (queue.length) {
    const { node, location: loc, kind } = queue.shift()!;
    if (kind === "schema" || (node.ns === XSD && node.local === "schema")) {
      schemas.push(node);
      for (const imp of [...childrenOf(node, "import", XSD), ...childrenOf(node, "include", XSD), ...childrenOf(node, "redefine", XSD)]) if (imp.attrs.schemaLocation) await follow(imp, loc, imp.attrs.schemaLocation, "schema");
      continue;
    }
    wsdls.push({ root: node, location: loc });
    for (const imp of childrenOf(node, "import", WSDL)) if (imp.attrs.location) await follow(imp, loc, imp.attrs.location, "wsdl");
    for (const types of childrenOf(node, "types", WSDL))
      for (const s of childrenOf(types, "schema", XSD)) {
        queue.push({ node: s, location: loc, kind: "schema" });
      }
  }
  return { wsdls, schemas };
}

/* ----------------------------- sample generation ----------------------------- */

type Index = {
  elements: Map<string, XNode>;
  complex: Map<string, XNode>;
  simple: Map<string, XNode>;
  /** xsd:schema element -> elementFormDefault is "qualified" */
  qualified: Map<XNode, boolean>;
};

function indexSchemas(schemas: XNode[]): Index {
  const ix: Index = { elements: new Map(), complex: new Map(), simple: new Map(), qualified: new Map() };
  for (const s of schemas) {
    const tns = s.attrs.targetNamespace ?? "";
    ix.qualified.set(s, s.attrs.elementFormDefault === "qualified");
    for (const c of s.children) {
      if (c.ns !== XSD || !c.attrs.name) continue;
      if (c.local === "element") ix.elements.set(key(tns, c.attrs.name), c);
      else if (c.local === "complexType") ix.complex.set(key(tns, c.attrs.name), c);
      else if (c.local === "simpleType") ix.simple.set(key(tns, c.attrs.name), c);
    }
  }
  return ix;
}

const schemaOf = (n: XNode): XNode | null => {
  for (let p: XNode | null = n; p; p = p.parent) if (p.ns === XSD && p.local === "schema") return p;
  return null;
};
const tnsOf = (n: XNode) => schemaOf(n)?.attrs.targetNamespace ?? "";

/** A value that is valid for an XSD built-in type. */
function builtinSample(local: string): string {
  if (/^(int|integer|long|short|byte|unsignedInt|unsignedLong|unsignedShort|unsignedByte|nonNegativeInteger|positiveInteger|negativeInteger|nonPositiveInteger)$/.test(local)) return local === "positiveInteger" ? "1" : local === "negativeInteger" ? "-1" : "0";
  if (/^(decimal|float|double)$/.test(local)) return "0.0";
  if (local === "boolean") return "false";
  if (local === "date") return "2024-01-01";
  if (local === "dateTime") return "2024-01-01T00:00:00Z";
  if (local === "time") return "00:00:00";
  if (local === "duration") return "PT0S";
  if (local === "base64Binary") return "";
  if (local === "hexBinary") return "00";
  if (local === "anyURI") return "https://example.com";
  return "?";
}

class Sampler {
  prefixes = new Map<string, string>(); // namespace uri -> prefix
  constructor(private ix: Index, private notes: string[]) {}

  prefixFor(uri: string): string {
    if (!uri) return "";
    let p = this.prefixes.get(uri);
    if (!p) {
      p = `ns${this.prefixes.size + 1}`;
      this.prefixes.set(uri, p);
    }
    return p;
  }

  private tag(local: string, ns: string) {
    const p = this.prefixFor(ns);
    return p ? `${p}:${local}` : local;
  }

  private simpleSample(type: XNode, depth: number): string {
    const r = firstChild(type, "restriction", XSD);
    if (r) {
      const en = firstChild(r, "enumeration", XSD);
      if (en) return en.attrs.value ?? "?";
      const base = qname(r, r.attrs.base);
      if (base) return this.typeValue(base.ns, base.local, depth + 1);
    }
    const u = firstChild(type, "union", XSD);
    if (u) {
      const first = (u.attrs.memberTypes ?? "").split(/\s+/)[0];
      const q = qname(u, first);
      if (q) return this.typeValue(q.ns, q.local, depth + 1);
    }
    const l = firstChild(type, "list", XSD);
    if (l) {
      const q = qname(l, l.attrs.itemType);
      if (q) return this.typeValue(q.ns, q.local, depth + 1);
    }
    return "?";
  }

  /** The text value for a simple (or built-in) type reference. */
  private typeValue(ns: string, local: string, depth: number): string {
    if (ns === XSD) return builtinSample(local);
    const st = this.ix.simple.get(key(ns, local));
    if (st && depth < 12) return this.simpleSample(st, depth);
    return "?";
  }

  /** The content (attributes + children) of a complex type, as [attributeText, childLines]. */
  private complexContent(ct: XNode, depth: number, stack: string[], pad: string): { attrs: string; kids: string[]; text: string | null } {
    let attrs = "";
    const kids: string[] = [];
    let text: string | null = null;
    const walk = (n: XNode) => {
      for (const c of n.children) {
        if (c.ns !== XSD) continue;
        if (c.local === "sequence" || c.local === "all") kids.push(...this.particles(c, depth, stack, pad));
        else if (c.local === "choice") {
          const first = c.children.find((x) => x.ns === XSD && ["element", "sequence", "choice", "group", "any"].includes(x.local));
          if (first) {
            const wrapper = { ...c, children: [first] } as XNode;
            kids.push(`${pad}<!--Choice: one of ${c.children.filter((x) => x.local === "element").map((x) => x.attrs.name ?? x.attrs.ref).filter(Boolean).join(", ") || "the options"}-->`, ...this.particles(wrapper, depth, stack, pad));
          }
        } else if (c.local === "attribute") {
          const name = c.attrs.name ?? c.attrs.ref;
          if (name && c.attrs.use !== "prohibited") {
            const t = qname(c, c.attrs.type);
            attrs += ` ${name.replace(/^.*:/, "")}="${escapeXml(t ? this.typeValue(t.ns, t.local, depth + 1) : "?")}"`;
          }
        } else if (c.local === "complexContent" || c.local === "simpleContent") {
          const ext = firstChild(c, "extension", XSD) ?? firstChild(c, "restriction", XSD);
          if (ext) {
            const base = qname(ext, ext.attrs.base);
            if (c.local === "simpleContent") {
              text = base ? this.typeValue(base.ns, base.local, depth + 1) : "?";
            } else if (base && ext.local === "extension") {
              const bt = this.ix.complex.get(key(base.ns, base.local));
              if (bt && depth < 12) {
                const inner = this.complexContent(bt, depth + 1, stack, pad);
                attrs += inner.attrs;
                kids.push(...inner.kids);
              }
            }
            walk(ext);
          }
        } else if (c.local === "group") {
          this.notes.includes("group") || this.notes.push("xsd:group references are shown as comments in the sample envelopes.");
          kids.push(`${pad}<!--group ${c.attrs.ref ?? c.attrs.name ?? ""}-->`);
        }
      }
    };
    walk(ct);
    if (ct.attrs.mixed === "true" && text === null && !kids.length) text = "?";
    return { attrs, kids, text };
  }

  private particles(group: XNode, depth: number, stack: string[], pad: string): string[] {
    const out: string[] = [];
    for (const c of group.children) {
      if (c.ns !== XSD) continue;
      if (c.local === "element") out.push(...this.element(c, depth + 1, stack, pad));
      else if (c.local === "sequence" || c.local === "all") out.push(...this.particles(c, depth, stack, pad));
      else if (c.local === "choice") {
        const first = c.children.find((x) => x.ns === XSD && x.local === "element");
        if (first) out.push(`${pad}<!--Choice-->`, ...this.element(first, depth + 1, stack, pad));
      } else if (c.local === "any") out.push(`${pad}<!--any element is allowed here-->`);
      else if (c.local === "group") out.push(`${pad}<!--group ${c.attrs.ref ?? ""}-->`);
    }
    return out;
  }

  /** XML lines for an element declaration (inline in a type, or top level). */
  element(decl: XNode, depth: number, stack: string[], pad: string, forceQualified = false): string[] {
    let d = decl;
    if (decl.attrs.ref) {
      const q = qname(decl, decl.attrs.ref);
      const target = q && this.ix.elements.get(key(q.ns, q.local));
      if (!target) return [`${pad}<!--unknown element ${decl.attrs.ref}-->`];
      d = target;
      forceQualified = true;
    }
    const name = d.attrs.name ?? "element";
    const topLevel = d.parent?.local === "schema";
    const schema = schemaOf(d);
    const qualified = topLevel || forceQualified || d.attrs.form === "qualified" || (d.attrs.form !== "unqualified" && !!schema && this.ix.qualified.get(schema) === true);
    const tag = this.tag(name, qualified ? tnsOf(d) : "");
    const min = decl.attrs.minOccurs, max = decl.attrs.maxOccurs;
    const notes: string[] = [];
    if (min === "0") notes.push(`${pad}<!--Optional:-->`);
    if (max === "unbounded" || (max && Number(max) > 1)) notes.push(`${pad}<!--${min === "0" ? "Zero" : "1"} or more repetitions:-->`);
    if (depth > 10) return [...notes, `${pad}<${tag}>...</${tag}>`];

    // the type: a reference, or defined inline
    let ct: XNode | undefined = firstChild(d, "complexType", XSD);
    let st: XNode | undefined = firstChild(d, "simpleType", XSD);
    const t = qname(d, d.attrs.type);
    let builtin: string | null = null;
    let typeKey = "";
    if (t) {
      if (t.ns === XSD) builtin = builtinSample(t.local);
      else {
        typeKey = key(t.ns, t.local);
        ct = this.ix.complex.get(typeKey);
        st = ct ? undefined : this.ix.simple.get(typeKey);
        if (!ct && !st) builtin = "?";
      }
    }
    if (typeKey && stack.includes(typeKey)) return [...notes, `${pad}<${tag}><!--recursive: ${t!.local}--></${tag}>`];
    if (ct) {
      const next = typeKey ? [...stack, typeKey] : stack;
      const c = this.complexContent(ct, depth, next, pad + "  ");
      if (!c.kids.length && c.text === null) return [...notes, `${pad}<${tag}${c.attrs}/>`];
      if (!c.kids.length) return [...notes, `${pad}<${tag}${c.attrs}>${escapeXml(c.text ?? "")}</${tag}>`];
      return [...notes, `${pad}<${tag}${c.attrs}>`, ...c.kids, `${pad}</${tag}>`];
    }
    const value = builtin ?? (st ? this.simpleSample(st, depth) : "?");
    return [...notes, `${pad}<${tag}>${escapeXml(value)}</${tag}>`];
  }

  /** A part given by `type` (rpc style): <partName>value-or-children</partName>. */
  typedPart(name: string, type: { ns: string; local: string }, pad: string): string[] {
    if (type.ns === XSD) return [`${pad}<${name}>${escapeXml(builtinSample(type.local))}</${name}>`];
    const ct = this.ix.complex.get(key(type.ns, type.local));
    if (ct) {
      const c = this.complexContent(ct, 0, [key(type.ns, type.local)], pad + "  ");
      if (!c.kids.length) return [`${pad}<${name}${c.attrs}>${escapeXml(c.text ?? "?")}</${name}>`];
      return [`${pad}<${name}${c.attrs}>`, ...c.kids, `${pad}</${name}>`];
    }
    return [`${pad}<${name}>${escapeXml(this.typeValue(type.ns, type.local, 0))}</${name}>`];
  }
}

/* ---------------------------------- build ---------------------------------- */

type Msg = { name: string; parts: { name: string; element?: { ns: string; local: string }; type?: { ns: string; local: string } }[] };

function messagesOf(wsdls: Doc[]): Map<string, Msg> {
  const out = new Map<string, Msg>();
  for (const { root } of wsdls) {
    const tns = root.attrs.targetNamespace ?? "";
    for (const m of childrenOf(root, "message", WSDL)) {
      out.set(key(tns, m.attrs.name ?? ""), {
        name: m.attrs.name ?? "",
        parts: childrenOf(m, "part", WSDL).map((p) => ({ name: p.attrs.name ?? "part", element: qname(p, p.attrs.element) ?? undefined, type: qname(p, p.attrs.type) ?? undefined })),
      });
    }
  }
  return out;
}

const pretty = (lines: string[]) => lines.join("\n");

function envelope(soap12: boolean, nsDecl: string, header: string[], body: string[]): string {
  const env = soap12 ? ENV12 : ENV11;
  return pretty([
    `<soapenv:Envelope xmlns:soapenv="${env}"${nsDecl}>`,
    header.length ? `  <soapenv:Header>` : `  <soapenv:Header/>`,
    ...(header.length ? [...header, `  </soapenv:Header>`] : []),
    `  <soapenv:Body>`,
    ...body,
    `  </soapenv:Body>`,
    `</soapenv:Envelope>`,
  ]);
}

function checkRoot(first: XNode) {
  if (first.ns === WSDL2) throw new Error("This is a WSDL 2.0 document. Cairn reads WSDL 1.1 (the format almost every SOAP service publishes): ask the service for its 1.1 WSDL.");
  if (!(first.ns === WSDL && first.local === "definitions")) throw new Error("This doesn't look like a WSDL document (the root element should be wsdl:definitions).");
}

/** Read a WSDL, following the imports it has through `opts.resolve`. */
export async function parseWsdl(text: string, location = "", opts: WsdlOptions = {}): Promise<ImportResult> {
  const notes: string[] = [];
  checkRoot(parseXml(text));
  const { wsdls, schemas } = await collect(text, location, opts, notes);
  return build(parseXml(text), wsdls, schemas, notes);
}

/** The same without imports (what is written in the one document): used for the quick preview. */
export function parseWsdlSync(text: string): ImportResult {
  const first = parseXml(text);
  checkRoot(first);
  const schemas = childrenOf(first, "types", WSDL).flatMap((t) => childrenOf(t, "schema", XSD));
  return build(first, [{ root: first, location: "" }], schemas, []);
}

function build(first: XNode, wsdls: Doc[], schemas: XNode[], notes: string[]): ImportResult {
  const ix = indexSchemas(schemas);
  const messages = messagesOf(wsdls);
  const portTypes = new Map<string, XNode>();
  const bindings = new Map<string, { node: XNode; tns: string }>();
  const services: { node: XNode; tns: string }[] = [];
  for (const { root } of wsdls) {
    const tns = root.attrs.targetNamespace ?? "";
    for (const p of childrenOf(root, "portType", WSDL)) portTypes.set(key(tns, p.attrs.name ?? ""), p);
    for (const b of childrenOf(root, "binding", WSDL)) bindings.set(key(tns, b.attrs.name ?? ""), { node: b, tns });
    for (const s of childrenOf(root, "service", WSDL)) services.push({ node: s, tns });
  }

  const requests: ImportedRequest[] = [];
  const vars: Record<string, string> = {};
  let skippedPorts = 0;
  const origin = (u: string) => /^(https?:\/\/[^/?#]+)/i.exec(u)?.[1] ?? "";

  for (const { node: service, tns } of services) {
    const serviceName = service.attrs.name ?? "Service";
    const ports = childrenOf(service, "port", WSDL);
    const soapPorts = ports.filter((p) => {
      const addr = p.children.find((c) => (c.ns === SOAP11 || c.ns === SOAP12) && c.local === "address");
      return !!addr;
    });
    skippedPorts += ports.length - soapPorts.length;
    for (const port of soapPorts) {
      const addr = port.children.find((c) => (c.ns === SOAP11 || c.ns === SOAP12) && c.local === "address")!;
      const soap12 = addr.ns === SOAP12;
      const location = addr.attrs.location ?? "";
      const b = qname(port, port.attrs.binding);
      const binding = b ? bindings.get(key(b.ns || tns, b.local)) ?? bindings.get(key(b.ns, b.local)) : undefined;
      if (!binding) {
        notes.push(`${serviceName}/${port.attrs.name}: its binding isn't defined, so it was skipped.`);
        continue;
      }
      const sb = binding.node.children.find((c) => (c.ns === SOAP11 || c.ns === SOAP12) && c.local === "binding");
      const defaultStyle = sb?.attrs.style ?? "document";
      const pt = qname(binding.node, binding.node.attrs.type);
      const portType = pt ? portTypes.get(key(pt.ns, pt.local)) : undefined;
      if (!portType) {
        notes.push(`${serviceName}/${port.attrs.name}: its portType isn't defined, so it was skipped.`);
        continue;
      }
      const o = origin(location);
      if (o && !vars.baseUrl) vars.baseUrl = o;
      const url = o && o === vars.baseUrl ? `{{baseUrl}}${location.slice(o.length)}` : location || "{{baseUrl}}";
      const folder = [serviceName, ...(soapPorts.length > 1 ? [port.attrs.name ?? "port"] : [])];

      for (const bop of childrenOf(binding.node, "operation", WSDL)) {
        const opName = bop.attrs.name ?? "operation";
        const pop = childrenOf(portType, "operation", WSDL).find((x) => x.attrs.name === opName);
        const so = bop.children.find((c) => (c.ns === SOAP11 || c.ns === SOAP12) && c.local === "operation");
        const style = so?.attrs.style ?? defaultStyle;
        const action = so?.attrs.soapAction ?? "";
        const bin = firstChild(bop, "input", WSDL);
        const body = bin?.children.find((c) => (c.ns === SOAP11 || c.ns === SOAP12) && c.local === "body");
        const use = body?.attrs.use ?? "literal";
        if (use === "encoded") notes.push(`${opName}: uses SOAP encoding (rpc/encoded); the envelope is a literal approximation.`);
        const inMsgRef = pop ? qname(pop, firstChild(pop, "input", WSDL)?.attrs.message) : null;
        const msg = inMsgRef ? messages.get(key(inMsgRef.ns, inMsgRef.local)) : undefined;
        if (!pop || !inMsgRef) {
          notes.push(`${opName}: no input message, so the envelope body is empty.`);
        }
        const sampler = new Sampler(ix, notes);
        const wanted = body?.attrs.parts ? new Set(body.attrs.parts.split(/\s+/)) : null;
        const parts = (msg?.parts ?? []).filter((p) => !wanted || wanted.has(p.name));
        const bodyLines: string[] = [];
        const pad = "    ";
        if (style === "rpc") {
          const nsUri = body?.attrs.namespace ?? tns;
          const p = sampler.prefixFor(nsUri);
          const inner: string[] = [];
          for (const part of parts) {
            if (part.type) inner.push(...sampler.typedPart(part.name, part.type, pad + "  "));
            else if (part.element) {
              const decl = ix.elements.get(key(part.element.ns, part.element.local));
              inner.push(...(decl ? sampler.element(decl, 0, [], pad + "  ", true) : [`${pad}  <!--unknown element ${part.element.local}-->`]));
            }
          }
          const tag = p ? `${p}:${opName}` : opName;
          bodyLines.push(...(inner.length ? [`${pad}<${tag}>`, ...inner, `${pad}</${tag}>`] : [`${pad}<${tag}/>`]));
        } else {
          for (const part of parts) {
            if (part.element) {
              const decl = ix.elements.get(key(part.element.ns, part.element.local));
              bodyLines.push(...(decl ? sampler.element(decl, 0, [], pad, true) : [`${pad}<!--element ${part.element.local} isn't defined in the schema-->`]));
            } else if (part.type) bodyLines.push(...sampler.typedPart(part.name, part.type, pad));
          }
        }
        // headers declared on the binding
        const headerLines: string[] = [];
        for (const h of (bin?.children ?? []).filter((c) => (c.ns === SOAP11 || c.ns === SOAP12) && c.local === "header")) {
          const hm = qname(h, h.attrs.message);
          const hmsg = hm ? messages.get(key(hm.ns, hm.local)) : undefined;
          const hpart = hmsg?.parts.find((p) => p.name === h.attrs.part);
          if (hpart?.element) {
            const decl = ix.elements.get(key(hpart.element.ns, hpart.element.local));
            if (decl) headerLines.push(...sampler.element(decl, 0, [], "    ", true));
          }
        }
        const nsDecl = [...sampler.prefixes.entries()].map(([uri, p]) => ` xmlns:${p}="${escapeXml(uri)}"`).join("");
        const xml = envelope(soap12, nsDecl, headerLines, bodyLines);

        const t: RequestTab = { ...newTab(), method: "POST", url, name: opName, bodyMode: "text", body: xml, source: `soap:${serviceName}/${port.attrs.name ?? ""}/${opName}` };
        t.headers = soap12
          ? [{ ...emptyKV(), key: "Content-Type", value: `application/soap+xml; charset=utf-8${action ? `; action="${action}"` : ""}` }, emptyKV()]
          : [{ ...emptyKV(), key: "Content-Type", value: "text/xml; charset=utf-8" }, { ...emptyKV(), key: "SOAPAction", value: `"${action}"` }, emptyKV()];
        requests.push({ folder, base: opName, tab: t });
      }
    }
  }
  if (skippedPorts) notes.push(`${skippedPorts} port${skippedPorts > 1 ? "s" : ""} with a non-SOAP binding (plain HTTP) ${skippedPorts > 1 ? "were" : "was"} skipped.`);
  if (!requests.length) throw new Error("No SOAP operations found: the WSDL has no service with a SOAP port.");
  const title = services[0]?.node.attrs.name ?? first.attrs.name ?? "SOAP service";
  return { title, vars, requests, notes: [...new Set(notes)] };
}
