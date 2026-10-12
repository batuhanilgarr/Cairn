import type { RequestTab } from "./lib/types";
import { CodeEditor, type VarMap } from "./CodeEditor";

/** Completions for the script API, so it's discoverable without reading docs. */
export const SCRIPT_COMPLETIONS = [
  ...["env.get", "env.set"].map((label) => ({ label, type: "function", detail: "session variable" })),
  ...["req.setHeader", "req.removeHeader", "req.getHeader"].map((label) => ({ label, type: "function", detail: "request" })),
  ...["req.method", "req.url", "req.headers", "req.body"].map((label) => ({ label, type: "property", detail: "request" })),
  ...["res.status", "res.statusText", "res.headers", "res.body", "res.time", "res.size"].map((label) => ({ label, type: "property", detail: "response" })),
  ...["res.json", "res.text", "res.header"].map((label) => ({ label, type: "function", detail: "response" })),
  { label: "test", type: "function", detail: "test(name, fn)" },
  ...["toBe", "toEqual", "toBeTruthy", "toBeFalsy", "toExist", "toContain", "toMatch", "toBeGreaterThan", "toBeLessThan", "toHaveProperty"].map((m) => ({ label: `expect(x).${m}`, type: "method", detail: "assertion" })),
  { label: "expect", type: "function", detail: "expect(value)" },
  { label: "console.log", type: "function" },
];

export function ScriptsPanel({ tab, patch, vars }: { tab: RequestTab; patch: (p: Partial<RequestTab>) => void; vars?: VarMap }) {
  return (
    <div className="scripts">
      <div className="script-col">
        <h4>Pre-request</h4>
        <CodeEditor
          className="boxed"
          lang="js"
          value={tab.preScript}
          vars={vars}
          completions={SCRIPT_COMPLETIONS}
          placeholder={"// runs before the request is sent\nenv.set('timestamp', Date.now());\nreq.setHeader('X-Trace', crypto.randomUUID());"}
          onChange={(v) => patch({ preScript: v })}
        />
      </div>
      <div className="script-col">
        <h4>Post-response</h4>
        <CodeEditor
          className="boxed"
          lang="js"
          value={tab.postScript}
          vars={vars}
          completions={SCRIPT_COMPLETIONS}
          placeholder={"// runs after the response arrives\ntest('created', () => expect(res.status).toBe(201));\nenv.set('userId', res.json().id);"}
          onChange={(v) => patch({ postScript: v })}
        />
      </div>
      <p className="muted small hint">
        <code>req</code> (method, url, headers, body, setHeader, removeHeader) · <code>res</code> (status, json(), text(), header(), time) ·{" "}
        <code>env.get/set</code> (session variables, kept in memory, never written to disk) · <code>test(name, fn)</code> ·{" "}
        <code>expect(x).toBe / toEqual / toContain / toMatch / toExist / toHaveProperty / not</code> · <code>console.log</code>.
        Scripts run in an isolated worker with a 5 s limit.
      </p>
    </div>
  );
}
