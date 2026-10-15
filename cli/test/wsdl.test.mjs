import test, { before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "../..");
let W, X;

before(async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-wsdl-")), "m.mjs");
  await build({
    stdin: { contents: `export * from "./src/lib/wsdl.ts"; export * from "./src/lib/xml.ts"; export { serializeRequest } from "./src/lib/collection.ts"; export { inspectSpec } from "./src/lib/openapi.ts";`, resolveDir: ROOT },
    outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    alias: {
      "@tauri-apps/api/core": path.join(ROOT, "cli/shims/tauri-core.ts"),
      "@tauri-apps/plugin-dialog": path.join(ROOT, "cli/shims/plugin-dialog.ts"),
      "@tauri-apps/plugin-opener": path.join(ROOT, "cli/shims/plugin-opener.ts"),
    },
  });
  const m = await import(out);
  W = m;
  X = m;
});

/** A document/literal service in the style of the classic calculator sample. */
const CALC = `<?xml version="1.0" encoding="utf-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/"
  xmlns:tns="http://tempuri.org/" xmlns:s="http://www.w3.org/2001/XMLSchema" targetNamespace="http://tempuri.org/" name="Calc">
  <wsdl:types>
    <s:schema elementFormDefault="qualified" targetNamespace="http://tempuri.org/">
      <s:element name="Add"><s:complexType><s:sequence>
        <s:element minOccurs="1" maxOccurs="1" name="intA" type="s:int"/>
        <s:element minOccurs="1" maxOccurs="1" name="intB" type="s:int"/>
      </s:sequence></s:complexType></s:element>
      <s:element name="AddResponse"><s:complexType><s:sequence><s:element minOccurs="1" maxOccurs="1" name="AddResult" type="s:int"/></s:sequence></s:complexType></s:element>
      <s:element name="Describe"><s:complexType><s:sequence>
        <s:element minOccurs="0" name="label" type="s:string"/>
        <s:element name="mode" type="tns:Mode"/>
        <s:element name="items" type="tns:ItemList"/>
        <s:element name="when" type="s:dateTime"/>
        <s:element name="flag" type="s:boolean"/>
      </s:sequence><s:attribute name="id" type="s:string"/></s:complexType></s:element>
      <s:simpleType name="Mode"><s:restriction base="s:string"><s:enumeration value="fast"/><s:enumeration value="safe"/></s:restriction></s:simpleType>
      <s:complexType name="ItemList"><s:sequence><s:element minOccurs="0" maxOccurs="unbounded" name="Item" type="tns:Item"/></s:sequence></s:complexType>
      <s:complexType name="Base"><s:sequence><s:element name="baseField" type="s:string"/></s:sequence></s:complexType>
      <s:complexType name="Item"><s:complexContent><s:extension base="tns:Base"><s:sequence><s:element name="qty" type="s:long"/></s:sequence></s:extension></s:complexContent></s:complexType>
    </s:schema>
  </wsdl:types>
  <wsdl:message name="AddSoapIn"><wsdl:part name="parameters" element="tns:Add"/></wsdl:message>
  <wsdl:message name="AddSoapOut"><wsdl:part name="parameters" element="tns:AddResponse"/></wsdl:message>
  <wsdl:message name="DescribeSoapIn"><wsdl:part name="parameters" element="tns:Describe"/></wsdl:message>
  <wsdl:message name="DescribeSoapOut"><wsdl:part name="parameters" element="tns:AddResponse"/></wsdl:message>
  <wsdl:portType name="CalcSoap">
    <wsdl:operation name="Add"><wsdl:input message="tns:AddSoapIn"/><wsdl:output message="tns:AddSoapOut"/></wsdl:operation>
    <wsdl:operation name="Describe"><wsdl:input message="tns:DescribeSoapIn"/><wsdl:output message="tns:DescribeSoapOut"/></wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="CalcSoap" type="tns:CalcSoap">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Add"><soap:operation soapAction="http://tempuri.org/Add" style="document"/><wsdl:input><soap:body use="literal"/></wsdl:input><wsdl:output><soap:body use="literal"/></wsdl:output></wsdl:operation>
    <wsdl:operation name="Describe"><soap:operation soapAction="http://tempuri.org/Describe" style="document"/><wsdl:input><soap:body use="literal"/></wsdl:input><wsdl:output><soap:body use="literal"/></wsdl:output></wsdl:operation>
  </wsdl:binding>
  <wsdl:binding name="CalcSoap12" type="tns:CalcSoap">
    <soap12:binding transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Add"><soap12:operation soapAction="http://tempuri.org/Add" style="document"/><wsdl:input><soap12:body use="literal"/></wsdl:input><wsdl:output><soap12:body use="literal"/></wsdl:output></wsdl:operation>
    <wsdl:operation name="Describe"><soap12:operation soapAction="http://tempuri.org/Describe" style="document"/><wsdl:input><soap12:body use="literal"/></wsdl:input><wsdl:output><soap12:body use="literal"/></wsdl:output></wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="Calc">
    <wsdl:port name="CalcSoap" binding="tns:CalcSoap"><soap:address location="https://calc.example.com/Calc.asmx"/></wsdl:port>
    <wsdl:port name="CalcSoap12" binding="tns:CalcSoap12"><soap12:address location="https://calc.example.com/Calc.asmx"/></wsdl:port>
  </wsdl:service>
</wsdl:definitions>`;

test("XML reader: namespaces, entities, CDATA, comments, self-closing, errors", () => {
  const r = X.parseXml(`<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "boom">]><a xmlns="urn:d" xmlns:p="urn:p"><!-- c --><p:b k='v&amp;w'>t&lt;1&#65;<![CDATA[<raw>]]></p:b><c/></a>`);
  assert.equal(r.local, "a");
  assert.equal(r.ns, "urn:d");
  const [b, c] = r.children;
  assert.deepEqual([b.local, b.ns, b.attrs.k, b.text], ["b", "urn:p", "v&w", "t<1A<raw>"]);
  assert.deepEqual([c.local, c.ns], ["c", "urn:d"]);
  assert.deepEqual(X.qname(b, "p:thing"), { ns: "urn:p", local: "thing" });
  assert.equal(X.qname(b, "nope:thing"), null);
  assert.equal(X.escapeXml(`a<b>&"c"`), "a&lt;b&gt;&amp;&quot;c&quot;");
  for (const bad of ["", "<a>", "<a></b>", "<a><b></a>", "<a x=1/>", "<p:a/>", "<a/><b/>", "text only"]) assert.throws(() => X.parseXml(bad), /Not well-formed XML/, bad);
  assert.throws(() => X.parseXml("<a>".repeat(400)), /nested too deeply|never closed/);
  // an entity bomb stays inert: only the predefined entities expand
  assert.ok(X.parseXml(`<!DOCTYPE a [<!ENTITY a "x"><!ENTITY b "&a;&a;&a;">]><r>&b;</r>`).text.includes("&b;"));
});

test("a document/literal WSDL gives one POST per operation and SOAP version, with a ready envelope", async () => {
  const r = await W.parseWsdl(CALC, "https://calc.example.com/Calc.asmx?wsdl");
  assert.equal(r.title, "Calc");
  assert.deepEqual(r.vars, { baseUrl: "https://calc.example.com" });
  assert.equal(r.requests.length, 4, "2 operations x SOAP 1.1 and 1.2");
  const add11 = r.requests.find((q) => q.tab.source === "soap:Calc/CalcSoap/Add");
  const add12 = r.requests.find((q) => q.tab.source === "soap:Calc/CalcSoap12/Add");
  assert.deepEqual(add11.folder, ["Calc", "CalcSoap"], "several ports: a folder each");
  assert.equal(add11.tab.method, "POST");
  assert.equal(add11.tab.url, "{{baseUrl}}/Calc.asmx");
  assert.equal(add11.tab.bodyMode, "text");
  const h = (t) => Object.fromEntries(t.headers.filter((x) => x.key).map((x) => [x.key, x.value]));
  assert.deepEqual(h(add11.tab), { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '"http://tempuri.org/Add"' });
  assert.deepEqual(h(add12.tab), { "Content-Type": 'application/soap+xml; charset=utf-8; action="http://tempuri.org/Add"' });
  assert.equal(add11.tab.body, `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://tempuri.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <ns1:Add>
      <ns1:intA>0</ns1:intA>
      <ns1:intB>0</ns1:intB>
    </ns1:Add>
  </soapenv:Body>
</soapenv:Envelope>`);
  assert.match(add12.tab.body, /xmlns:soapenv="http:\/\/www\.w3\.org\/2003\/05\/soap-envelope"/);
});

test("the sample follows the schema: enumerations, lists, extensions, optional and repeated elements, attributes, built-in types", async () => {
  const r = await W.parseWsdl(CALC, "");
  const body = r.requests.find((q) => q.tab.source === "soap:Calc/CalcSoap/Describe").tab.body;
  assert.match(body, /<ns1:Describe id="\?">/);
  assert.match(body, /<!--Optional:-->\n\s+<ns1:label>\?<\/ns1:label>/);
  assert.match(body, /<ns1:mode>fast<\/ns1:mode>/, "the first enumeration value");
  assert.match(body, /<!--Optional:-->\n\s+<!--Zero or more repetitions:-->\n\s+<ns1:Item>/);
  assert.match(body, /<ns1:baseField>\?<\/ns1:baseField>\n\s+<ns1:qty>0<\/ns1:qty>/, "an extension includes its base type first");
  assert.match(body, /<ns1:when>2024-01-01T00:00:00Z<\/ns1:when>/);
  assert.match(body, /<ns1:flag>false<\/ns1:flag>/);
  // it is well-formed XML
  assert.doesNotThrow(() => X.parseXml(body));
  for (const q of r.requests) assert.doesNotThrow(() => X.parseXml(q.tab.body), q.tab.name);
});

test("rpc/literal: a wrapper named after the operation, parts as children, the binding's namespace", async () => {
  const wsdl = `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:hello" targetNamespace="urn:hello" name="HelloService">
    <types><xsd:schema targetNamespace="urn:hello"><xsd:complexType name="Person"><xsd:sequence><xsd:element name="first" type="xsd:string"/><xsd:element name="age" type="xsd:int"/></xsd:sequence></xsd:complexType></xsd:schema></types>
    <message name="SayHelloRequest"><part name="name" type="xsd:string"/><part name="who" type="tns:Person"/></message>
    <message name="SayHelloResponse"><part name="greeting" type="xsd:string"/></message>
    <portType name="Hello_PortType"><operation name="sayHello"><input message="tns:SayHelloRequest"/><output message="tns:SayHelloResponse"/></operation></portType>
    <binding name="Hello_Binding" type="tns:Hello_PortType"><soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/>
      <operation name="sayHello"><soap:operation soapAction="sayHello"/><input><soap:body use="literal" namespace="urn:examples:helloservice"/></input><output><soap:body use="literal" namespace="urn:examples:helloservice"/></output></operation></binding>
    <service name="Hello_Service"><port name="Hello_Port" binding="tns:Hello_Binding"><soap:address location="http://www.examples.com/SayHello/"/></port></service>
  </definitions>`;
  const r = await W.parseWsdl(wsdl);
  assert.equal(r.requests.length, 1);
  const q = r.requests[0];
  assert.deepEqual(q.folder, ["Hello_Service"], "one port: no port folder");
  assert.equal(q.tab.url, "{{baseUrl}}/SayHello/");
  assert.equal(q.tab.body, `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:examples:helloservice">
  <soapenv:Header/>
  <soapenv:Body>
    <ns1:sayHello>
      <name>?</name>
      <who>
        <first>?</first>
        <age>0</age>
      </who>
    </ns1:sayHello>
  </soapenv:Body>
</soapenv:Envelope>`);
});

test("imported schemas and WSDLs are fetched through the resolver; what can't be loaded is reported", async () => {
  const main = `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:t" targetNamespace="urn:t" name="S">
    <types><xsd:schema targetNamespace="urn:t"><xsd:import namespace="urn:t" schemaLocation="types/t.xsd"/><xsd:import namespace="urn:gone" schemaLocation="gone.xsd"/></xsd:schema></types>
    <message name="In"><part name="p" element="t:Ping"/></message>
    <portType name="P"><operation name="Ping"><input message="t:In"/></operation></portType>
    <binding name="B" type="t:P"><soap:binding style="document" transport="x"/><operation name="Ping"><soap:operation soapAction="urn:Ping"/><input><soap:body use="literal"/></input></operation></binding>
    <service name="S"><port name="Pt" binding="t:B"><soap:address location="http://h.example/s"/></port></service></definitions>`;
  const files = { "https://h.example/wsdl/types/t.xsd": `<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t" elementFormDefault="qualified"><xsd:element name="Ping"><xsd:complexType><xsd:sequence><xsd:element name="n" type="xsd:int"/></xsd:sequence></xsd:complexType></xsd:element></xsd:schema>` };
  const asked = [];
  const r = await W.parseWsdl(main, "https://h.example/wsdl/s.wsdl", { resolve: async (u) => (asked.push(u), files[u] ?? null) });
  assert.deepEqual(asked, ["https://h.example/wsdl/types/t.xsd", "https://h.example/wsdl/gone.xsd"]);
  assert.match(r.requests[0].tab.body, /<ns1:Ping>\n\s+<ns1:n>0<\/ns1:n>/);
  assert.ok(r.notes.some((n) => /Couldn't load gone\.xsd/.test(n)), r.notes.join(" | "));
  // without a resolver the type is unknown and the envelope says so instead of failing
  const lone = await W.parseWsdl(main, "");
  assert.match(lone.requests[0].tab.body, /isn't defined in the schema/);
});

test("SOAP headers declared on the binding are included", async () => {
  const wsdl = `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:t" targetNamespace="urn:t" name="S">
    <types><xsd:schema targetNamespace="urn:t" elementFormDefault="qualified"><xsd:element name="Auth"><xsd:complexType><xsd:sequence><xsd:element name="user" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element><xsd:element name="Do" type="xsd:string"/></xsd:schema></types>
    <message name="In"><part name="b" element="t:Do"/></message><message name="H"><part name="auth" element="t:Auth"/></message>
    <portType name="P"><operation name="Do"><input message="t:In"/></operation></portType>
    <binding name="B" type="t:P"><soap:binding style="document" transport="x"/><operation name="Do"><soap:operation soapAction=""/><input><soap:body use="literal"/><soap:header message="t:H" part="auth" use="literal"/></input></operation></binding>
    <service name="S"><port name="Pt" binding="t:B"><soap:address location="http://h.example/s"/></port></service></definitions>`;
  const q = (await W.parseWsdl(wsdl)).requests[0];
  assert.match(q.tab.body, /<soapenv:Header>\n\s+<ns1:Auth>\n\s+<ns1:user>\?<\/ns1:user>\n\s+<\/ns1:Auth>\n\s+<\/soapenv:Header>/);
  assert.match(q.tab.body, /<ns1:Do>\?<\/ns1:Do>/);
  assert.equal(q.tab.headers.find((h) => h.key === "SOAPAction").value, '""', "an empty SOAPAction is still sent, quoted");
});

test("recursive types stop instead of looping forever", async () => {
  const wsdl = `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:t" targetNamespace="urn:t" name="S">
    <types><xsd:schema targetNamespace="urn:t" elementFormDefault="qualified"><xsd:complexType name="Node"><xsd:sequence><xsd:element name="value" type="xsd:int"/><xsd:element name="child" type="t:Node" minOccurs="0"/></xsd:sequence></xsd:complexType><xsd:element name="Tree" type="t:Node"/></xsd:schema></types>
    <message name="In"><part name="b" element="t:Tree"/></message>
    <portType name="P"><operation name="Put"><input message="t:In"/></operation></portType>
    <binding name="B" type="t:P"><soap:binding style="document" transport="x"/><operation name="Put"><soap:operation soapAction="put"/><input><soap:body use="literal"/></input></operation></binding>
    <service name="S"><port name="Pt" binding="t:B"><soap:address location="http://h.example/s"/></port></service></definitions>`;
  const q = (await W.parseWsdl(wsdl)).requests[0];
  assert.match(q.tab.body, /<!--recursive: Node-->/);
  assert.ok(q.tab.body.length < 2000);
  assert.doesNotThrow(() => X.parseXml(q.tab.body));
});

test("clear errors: WSDL 2.0, not a WSDL, no SOAP service, broken XML", async () => {
  await assert.rejects(W.parseWsdl(`<description xmlns="http://www.w3.org/ns/wsdl" targetNamespace="urn:x"/>`), /WSDL 2\.0/);
  await assert.rejects(W.parseWsdl(`<html><body/></html>`), /doesn't look like a WSDL/);
  await assert.rejects(W.parseWsdl(`<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" name="E"/>`), /No SOAP operations found/);
  await assert.rejects(W.parseWsdl(`<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"><oops></definitions>`), /Not well-formed XML/);
});

test("WSDL text is recognised, and the paste preview knows about it", async () => {
  assert.equal(W.isWsdl(CALC), true);
  assert.equal(W.isWsdl(`<?xml version="1.0"?><html/>`), false);
  assert.equal(W.isWsdl(`{"openapi":"3.0.0"}`), false);
  const i = W.inspectSpec(CALC);
  assert.equal(i.kind, "wsdl");
  assert.equal(i.title, "Calc");
  assert.equal(i.requests, 4);
  assert.match(i.names[0], /^POST Calc\/CalcSoap\/Add/);
  assert.equal(W.inspectSpec("<definitions xmlns=\"http://schemas.xmlsoap.org/wsdl/\"><oops></definitions>").kind, "other");
});

test("the requests round-trip through the file format with their envelope intact", async () => {
  const r = await W.parseWsdl(CALC, "");
  const q = r.requests[0].tab;
  const text = W.serializeRequest(q);
  assert.match(text, /body:\n {2}mode: text\n {2}content: \|-\n {4}<soapenv:Envelope/);
});
