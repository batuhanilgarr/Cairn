import { useEffect, useMemo } from "react";

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function hexDump(bytes: Uint8Array, max = 512): string {
  const lines: string[] = [];
  for (let i = 0; i < Math.min(bytes.length, max); i += 16) {
    const row = bytes.slice(i, i + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
    const asc = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex}  ${asc}`);
  }
  if (bytes.length > max) lines.push(`… ${bytes.length - max} more bytes`);
  return lines.join("\n");
}

/** Preview of a binary response: image, audio, video, PDF inline; anything else as a hex dump. */
export function BinaryView({ base64, contentType, size }: { base64: string; contentType: string; size: number }) {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  const bytes = useMemo(() => b64ToBytes(base64), [base64]);
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes], { type: ct || "application/octet-stream" })), [bytes, ct]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  if (ct.startsWith("image/")) return <div className="bin-media"><img src={url} alt="Response" /></div>;
  if (ct.startsWith("video/")) return <div className="bin-media"><video src={url} controls /></div>;
  if (ct.startsWith("audio/")) return <div className="bin-media"><audio src={url} controls /></div>;
  if (ct === "application/pdf") return <object className="bin-pdf" data={url} type="application/pdf" aria-label="PDF response" />;
  return (
    <div className="bin-hex">
      <p className="muted small">Binary response · {ct || "unknown type"} · {size} bytes. Use Save to keep it.</p>
      <pre className="code">{hexDump(bytes)}</pre>
    </div>
  );
}

const EXT: Record<string, string> = {
  "application/json": "json", "text/html": "html", "text/plain": "txt", "text/css": "css", "text/csv": "csv", "application/xml": "xml", "text/xml": "xml",
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "application/pdf": "pdf", "application/zip": "zip",
  "audio/mpeg": "mp3", "video/mp4": "mp4", "application/javascript": "js", "application/yaml": "yaml",
};

/** A sensible file name for saving: Content-Disposition, else the URL's last segment, plus an extension from the type. */
export function suggestFileName(url: string, headers: [string, string][], contentType: string): string {
  const cd = headers.find(([k]) => k.toLowerCase() === "content-disposition")?.[1] ?? "";
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (m) return decodeURIComponent(m[1]);
  let seg = "response";
  try {
    seg = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "") || "response";
  } catch {
    /* keep default */
  }
  const ext = EXT[contentType.split(";")[0].trim().toLowerCase()];
  return ext && !seg.includes(".") ? `${seg}.${ext}` : seg;
}
