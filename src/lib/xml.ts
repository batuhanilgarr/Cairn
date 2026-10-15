/**
 * A small, namespace-aware XML reader for WSDL and XSD files (no dependency, works in the app and in Node).
 * It reads well-formed XML: elements, attributes, text, CDATA, comments, processing instructions and a skipped
 * DOCTYPE. Only the five predefined entities and numeric references are expanded, so a hostile document can't
 * make it expand anything.
 */
export type XNode = {
  /** The name as written, e.g. "xsd:element". */
  name: string;
  prefix: string;
  local: string;
  /** Namespace URI of the element ("" for none). */
  ns: string;
  /** Attributes by their written name (xmlns declarations are kept out; see `scope`). */
  attrs: Record<string, string>;
  children: XNode[];
  /** The text directly inside, trimmed. */
  text: string;
  /** Prefix -> namespace URI in effect at this element ("" is the default namespace). */
  scope: Record<string, string>;
  parent: XNode | null;
};

const MAX_DEPTH = 256;
const ENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENT[e] ?? m;
  });

export function parseXml(input: string): XNode {
  const src = input.replace(/^﻿/, "");
  let i = 0;
  function fail(msg: string): never {
    const line = src.slice(0, i).split("\n").length;
    throw new Error(`Not well-formed XML: ${msg} (line ${line})`);
  }
  function skipUntil(end: string, what: string) {
    const j = src.indexOf(end, i);
    if (j < 0) fail(`unterminated ${what}`);
    i = j + end.length;
  }

  let root: XNode | null = null;
  let cur: XNode | null = null;
  const emptyScope: Record<string, string> = { xml: "http://www.w3.org/XML/1998/namespace" };

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      if (src.slice(i).trim() && cur) fail("text after the last element");
      break;
    }
    if (lt > i && cur) cur.text += decode(src.slice(i, lt));
    i = lt;
    if (src.startsWith("<!--", i)) {
      skipUntil("-->", "comment");
    } else if (src.startsWith("<![CDATA[", i)) {
      const j = src.indexOf("]]>", i);
      if (j < 0) fail("unterminated CDATA");
      if (cur) cur.text += src.slice(i + 9, j);
      i = j + 3;
    } else if (src.startsWith("<?", i)) {
      skipUntil("?>", "processing instruction");
    } else if (src.startsWith("<!", i)) {
      // DOCTYPE: skip, including an internal subset in [...]
      let depth = 0;
      i += 2;
      while (i < src.length && !(src[i] === ">" && depth === 0)) {
        if (src[i] === "[") depth++;
        else if (src[i] === "]") depth--;
        i++;
      }
      i++;
    } else if (src.startsWith("</", i)) {
      const j = src.indexOf(">", i);
      if (j < 0) fail("unterminated closing tag");
      const name = src.slice(i + 2, j).trim();
      if (!cur || cur.name !== name) fail(`</${name}> doesn't match ${cur ? `<${cur.name}>` : "an open element"}`);
      cur.text = cur.text.trim();
      cur = cur.parent;
      i = j + 1;
    } else {
      // an opening tag: name, attributes, optional "/"
      const m = /^<([^\s/>]+)/.exec(src.slice(i, i + 300));
      if (!m) fail("expected an element name");
      const name = m![1];
      i += m![0].length;
      const attrs: Record<string, string> = {};
      const scope: Record<string, string> = { ...(cur?.scope ?? emptyScope) };
      let selfClosing = false;
      for (;;) {
        while (i < src.length && /\s/.test(src[i])) i++;
        if (src[i] === "/" && src[i + 1] === ">") {
          selfClosing = true;
          i += 2;
          break;
        }
        if (src[i] === ">") {
          i++;
          break;
        }
        const am = /^([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(src.slice(i, i + 4000));
        if (!am) return fail(`bad attribute in <${name}>`);
        const value = decode(am[3] ?? am[4] ?? "");
        if (am[1] === "xmlns") scope[""] = value;
        else if (am[1].startsWith("xmlns:")) scope[am[1].slice(6)] = value;
        else attrs[am[1]] = value;
        i += am[0].length;
      }
      const c = name.indexOf(":");
      const prefix = c < 0 ? "" : name.slice(0, c);
      const node: XNode = { name, prefix, local: c < 0 ? name : name.slice(c + 1), ns: scope[prefix] ?? "", attrs, children: [], text: "", scope, parent: cur };
      if (prefix && !(prefix in scope)) fail(`the prefix "${prefix}" isn't declared`);
      if (cur) cur.children.push(node);
      else if (root) fail("more than one root element");
      else root = node;
      if (!selfClosing) {
        cur = node;
        let d = 0;
        for (let p: XNode | null = node; p; p = p.parent) d++;
        if (d > MAX_DEPTH) fail("elements are nested too deeply");
      }
    }
  }
  if (cur) fail(`<${cur.name}> is never closed`);
  if (!root) fail("no root element");
  return root as XNode;
}

/** Resolve a QName such as "tns:Foo" using the namespaces in scope at `node`. */
export function qname(node: XNode, value: string | undefined): { ns: string; local: string } | null {
  if (!value) return null;
  const c = value.indexOf(":");
  const prefix = c < 0 ? "" : value.slice(0, c);
  const local = c < 0 ? value : value.slice(c + 1);
  const ns = node.scope[prefix];
  if (ns === undefined && prefix) return null;
  return { ns: ns ?? "", local };
}

export const childrenOf = (n: XNode, local: string, ns?: string) => n.children.filter((c) => c.local === local && (ns === undefined || c.ns === ns));
export const firstChild = (n: XNode, local: string, ns?: string) => childrenOf(n, local, ns)[0];

/** Escape text for use inside an element or an attribute. */
export const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
