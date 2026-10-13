export type MultipartField = { name: string; value: string; file: boolean; contentType?: string };
export type Snippet = { method: string; url: string; headers: [string, string][]; body?: string; multipart?: MultipartField[]; bodyFile?: string };

export type Lang = { id: string; label: string; gen: (s: Snippet) => string };

const dq = (s: string) => JSON.stringify(s);
const sq = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const kt = (s: string) => JSON.stringify(s).replace(/\$/g, "\\$");
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const hasBody = (s: Snippet) => s.body !== undefined && s.body !== "";
const ind = (n: number, text: string) => text.split("\n").map((l) => " ".repeat(n) + l).join("\n");
const isJson = (s: string | undefined) => {
  try {
    return !!s && typeof JSON.parse(s) === "object";
  } catch {
    return false;
  }
};

const curl: Lang = {
  id: "curl",
  label: "cURL",
  gen: (s) => {
    const parts = [`curl -X ${s.method} ${shq(s.url)}`];
    for (const [k, v] of s.headers) parts.push(`-H ${shq(`${k}: ${v}`)}`);
    if (s.multipart) for (const f of s.multipart) parts.push(`-F ${shq(`${f.name}=${f.file ? "@" : ""}${f.value}${f.contentType ? `;type=${f.contentType}` : ""}`)}`);
    else if (s.bodyFile) parts.push(`--data-binary ${shq(`@${s.bodyFile}`)}`);
    else if (hasBody(s)) parts.push(`-d ${shq(s.body!)}`);
    return parts.join(" \\\n  ");
  },
};

const httpie: Lang = {
  id: "httpie",
  label: "HTTPie",
  gen: (s) => {
    const parts = [`http ${s.method} ${shq(s.url)}`];
    for (const [k, v] of s.headers) parts.push(shq(`${k}:${v}`));
    const body = hasBody(s) ? ` <<'EOF'\n${s.body}\nEOF` : "";
    return parts.join(" \\\n  ") + body;
  },
};

const fetchJs: Lang = {
  id: "fetch",
  label: "JavaScript · fetch",
  gen: (s) => {
    const opts = [`  method: ${dq(s.method)},`];
    if (s.headers.length) opts.push(`  headers: {\n${s.headers.map(([k, v]) => `    ${dq(k)}: ${dq(v)},`).join("\n")}\n  },`);
    let prelude = "";
    if (s.multipart) {
      prelude = `const form = new FormData();\n${s.multipart.map((f) => (f.file ? `form.append(${dq(f.name)}, await fs.openAsBlob(${dq(f.value)}${f.contentType ? `, { type: ${dq(f.contentType)} }` : ""}), ${dq(f.value.split("/").pop() ?? "file")});` : `form.append(${dq(f.name)}, ${dq(f.value)});`)).join("\n")}\n\n`;
      if (s.multipart.some((f) => f.file)) prelude = `import fs from "node:fs";\n\n${prelude}`;
      opts.push("  body: form,");
    } else if (s.bodyFile) {
      prelude = `import fs from "node:fs";\n\n`;
      opts.push(`  body: await fs.promises.readFile(${dq(s.bodyFile)}),`);
    } else if (hasBody(s)) opts.push(`  body: ${isJson(s.body) ? `JSON.stringify(${JSON.stringify(JSON.parse(s.body!), null, 2).replace(/\n/g, "\n  ")})` : dq(s.body!)},`);
    return `${prelude}const response = await fetch(${dq(s.url)}, {\n${opts.join("\n")}\n});\nconst data = await response.text();\nconsole.log(response.status, data);`;
  },
};

const axios: Lang = {
  id: "axios",
  label: "Node · axios",
  gen: (s) => {
    const opts = [`  method: ${dq(s.method.toLowerCase())},`, `  url: ${dq(s.url)},`];
    if (s.headers.length) opts.push(`  headers: {\n${s.headers.map(([k, v]) => `    ${dq(k)}: ${dq(v)},`).join("\n")}\n  },`);
    if (hasBody(s)) opts.push(`  data: ${isJson(s.body) ? JSON.stringify(JSON.parse(s.body!), null, 2).replace(/\n/g, "\n  ") : dq(s.body!)},`);
    return `import axios from "axios";\n\nconst res = await axios({\n${opts.join("\n")}\n});\nconsole.log(res.status, res.data);`;
  },
};

const python: Lang = {
  id: "python",
  label: "Python · requests",
  gen: (s) => {
    const lines = ["import requests", "", `url = ${dq(s.url)}`];
    if (s.headers.length) lines.push(`headers = {\n${s.headers.map(([k, v]) => `    ${dq(k)}: ${dq(v)},`).join("\n")}\n}`);
    if (s.multipart) {
      const data = s.multipart.filter((f) => !f.file);
      const files = s.multipart.filter((f) => f.file);
      if (data.length) lines.push(`data = {\n${data.map((f) => `    ${dq(f.name)}: ${dq(f.value)},`).join("\n")}\n}`);
      if (files.length) lines.push(`files = {\n${files.map((f) => `    ${dq(f.name)}: (${dq(f.value.split("/").pop() ?? "file")}, open(${dq(f.value)}, "rb")${f.contentType ? `, ${dq(f.contentType)}` : ""}),`).join("\n")}\n}`);
    } else if (s.bodyFile) lines.push(`payload = open(${dq(s.bodyFile)}, "rb").read()`);
    else if (hasBody(s)) lines.push(`payload = ${dq(s.body!)}`);
    const args = [
      `${dq(s.method)}`,
      "url",
      ...(s.headers.length ? ["headers=headers"] : []),
      ...(s.multipart ? [...(s.multipart.some((f) => !f.file) ? ["data=data"] : []), ...(s.multipart.some((f) => f.file) ? ["files=files"] : [])] : s.bodyFile || hasBody(s) ? ["data=payload"] : []),
    ];
    lines.push("", `response = requests.request(${args.join(", ")})`, "print(response.status_code, response.text)");
    return lines.join("\n");
  },
};

const go: Lang = {
  id: "go",
  label: "Go · net/http",
  gen: (s) => {
    const body = hasBody(s) ? `strings.NewReader(${dq(s.body!)})` : "nil";
    return `package main

import (
	"fmt"
	"io"
	"net/http"${hasBody(s) ? '\n\t"strings"' : ""}
)

func main() {
	req, err := http.NewRequest(${dq(s.method)}, ${dq(s.url)}, ${body})
	if err != nil {
		panic(err)
	}
${s.headers.map(([k, v]) => `\treq.Header.Set(${dq(k)}, ${dq(v)})`).join("\n")}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	fmt.Println(res.StatusCode, string(b))
}`;
  },
};

const java: Lang = {
  id: "java",
  label: "Java · HttpClient",
  gen: (s) => {
    const pub = hasBody(s) ? `HttpRequest.BodyPublishers.ofString(${dq(s.body!)})` : "HttpRequest.BodyPublishers.noBody()";
    return `import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class Main {
  public static void main(String[] args) throws Exception {
    HttpRequest request = HttpRequest.newBuilder()
        .uri(URI.create(${dq(s.url)}))
${s.headers.map(([k, v]) => `        .header(${dq(k)}, ${dq(v)})`).join("\n")}
        .method(${dq(s.method)}, ${pub})
        .build();
    HttpResponse<String> response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
    System.out.println(response.statusCode() + " " + response.body());
  }
}`;
  },
};

const kotlin: Lang = {
  id: "kotlin",
  label: "Kotlin · OkHttp",
  gen: (s) => {
    const ct = s.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "text/plain";
    const body = hasBody(s) ? `${kt(s.body!)}.toRequestBody(${kt(ct)}.toMediaType())` : s.method === "GET" || s.method === "HEAD" ? "null" : `"".toRequestBody(null)`;
    return `import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

val client = OkHttpClient()
val request = Request.Builder()
    .url(${kt(s.url)})
${s.headers.map(([k, v]) => `    .addHeader(${kt(k)}, ${kt(v)})`).join("\n")}
    .method(${kt(s.method)}, ${body})
    .build()
client.newCall(request).execute().use { println("\${it.code} \${it.body?.string()}") }`;
  },
};

const swift: Lang = {
  id: "swift",
  label: "Swift · URLSession",
  gen: (s) => `import Foundation

var request = URLRequest(url: URL(string: ${dq(s.url)})!)
request.httpMethod = ${dq(s.method)}
${s.headers.map(([k, v]) => `request.setValue(${dq(v)}, forHTTPHeaderField: ${dq(k)})`).join("\n")}
${hasBody(s) ? `request.httpBody = ${dq(s.body!)}.data(using: .utf8)\n` : ""}
let (data, response) = try await URLSession.shared.data(for: request)
print((response as! HTTPURLResponse).statusCode, String(decoding: data, as: UTF8.self))`,
};

const csharp: Lang = {
  id: "csharp",
  label: "C# · HttpClient",
  gen: (s) => {
    const ct = s.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1];
    const rest = s.headers.filter(([k]) => k.toLowerCase() !== "content-type");
    return `using System.Net.Http;
using System.Text;

var client = new HttpClient();
var request = new HttpRequestMessage(new HttpMethod(${dq(s.method)}), ${dq(s.url)});
${rest.map(([k, v]) => `request.Headers.TryAddWithoutValidation(${dq(k)}, ${dq(v)});`).join("\n")}
${hasBody(s) ? `request.Content = new StringContent(${dq(s.body!)}, Encoding.UTF8${ct ? `, ${dq(ct.split(";")[0])}` : ""});\n` : ""}var response = await client.SendAsync(request);
Console.WriteLine($"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");`;
  },
};

const php: Lang = {
  id: "php",
  label: "PHP · cURL",
  gen: (s) => `<?php
$ch = curl_init(${sq(s.url)});
curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST => ${sq(s.method)},
    CURLOPT_RETURNTRANSFER => true,
${s.headers.length ? `    CURLOPT_HTTPHEADER => [\n${s.headers.map(([k, v]) => `        ${sq(`${k}: ${v}`)},`).join("\n")}\n    ],\n` : ""}${hasBody(s) ? `    CURLOPT_POSTFIELDS => ${sq(s.body!)},\n` : ""}]);
$response = curl_exec($ch);
echo curl_getinfo($ch, CURLINFO_HTTP_CODE), " ", $response;
curl_close($ch);`,
};

const ruby: Lang = {
  id: "ruby",
  label: "Ruby · Net::HTTP",
  gen: (s) => `require "net/http"
require "uri"

uri = URI(${sq(s.url)})
http = Net::HTTP.new(uri.host, uri.port)
http.use_ssl = uri.scheme == "https"
request = Net::HTTPGenericRequest.new(${sq(s.method)}, ${hasBody(s) ? "true" : "false"}, true, uri.request_uri)
${s.headers.map(([k, v]) => `request[${sq(k)}] = ${sq(v)}`).join("\n")}
${hasBody(s) ? `request.body = ${sq(s.body!)}\n` : ""}response = http.request(request)
puts "#{response.code} #{response.body}"`,
};

const rust: Lang = {
  id: "rust",
  label: "Rust · reqwest",
  gen: (s) => `let client = reqwest::Client::new();
let res = client
    .request(reqwest::Method::from_bytes(b${dq(s.method)}).unwrap(), ${dq(s.url)})
${s.headers.map(([k, v]) => `    .header(${dq(k)}, ${dq(v)})`).join("\n")}
${hasBody(s) ? `    .body(${dq(s.body!)})\n` : ""}    .send()
    .await?;
println!("{} {}", res.status(), res.text().await?);`,
};

const powershell: Lang = {
  id: "powershell",
  label: "PowerShell",
  gen: (s) => `$headers = @{\n${s.headers.map(([k, v]) => `    ${psq(k)} = ${psq(v)}`).join("\n")}\n}\n${hasBody(s) ? `$body = ${psq(s.body!)}\n` : ""}Invoke-RestMethod -Method ${s.method} -Uri ${psq(s.url)}${s.headers.length ? " -Headers $headers" : ""}${hasBody(s) ? " -Body $body" : ""}`,
};

/** Languages whose generator knows about multipart/form-data and file bodies. The rest get a pointer to cURL. */
const FILE_AWARE = new Set(["curl", "fetch", "python"]);
const HASH = new Set(["httpie", "ruby", "powershell"]);
const withFileNote = (l: Lang): Lang =>
  FILE_AWARE.has(l.id)
    ? l
    : { ...l, gen: (s) => ((s.multipart || s.bodyFile) ? `${HASH.has(l.id) ? "#" : "//"} This request sends ${s.multipart ? "multipart/form-data" : "a file body"}, which isn't generated for ${l.label} yet: the body below is empty.\n${HASH.has(l.id) ? "#" : "//"} Use the cURL snippet as a reference.\n${l.gen({ ...s, multipart: undefined, bodyFile: undefined })}` : l.gen(s)) };

export const LANGS: Lang[] = [curl, httpie, fetchJs, axios, python, go, java, kotlin, swift, csharp, php, ruby, rust, powershell].map(withFileNote);
export { ind };
