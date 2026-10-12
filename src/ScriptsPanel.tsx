import type { RequestTab } from "./lib/types";

export function ScriptsPanel({ tab, patch }: { tab: RequestTab; patch: (p: Partial<RequestTab>) => void }) {
  return (
    <div className="scripts">
      <div className="script-col">
        <h4>Pre-request</h4>
        <textarea
          className="editor code-editor"
          spellCheck={false}
          placeholder={"// runs before the request is sent\nenv.set('timestamp', Date.now());\nreq.setHeader('X-Trace', crypto.randomUUID());"}
          value={tab.preScript}
          onChange={(e) => patch({ preScript: e.target.value })}
        />
      </div>
      <div className="script-col">
        <h4>Post-response</h4>
        <textarea
          className="editor code-editor"
          spellCheck={false}
          placeholder={"// runs after the response arrives\ntest('created', () => expect(res.status).toBe(201));\nenv.set('userId', res.json().id);"}
          value={tab.postScript}
          onChange={(e) => patch({ postScript: e.target.value })}
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
