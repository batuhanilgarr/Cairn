import { focusScope } from "./lib/focusScope";

export type RunItem = {
  name: string;
  state: "pending" | "running" | "done";
  status?: number;
  ms?: number;
  passed: number;
  failed: number;
  error?: string;
  failures: string[];
};
export type RunState = { title: string; items: RunItem[]; done: boolean };

const statusClass = (n: number) => (n >= 500 ? "s5" : n >= 400 ? "s4" : n >= 300 ? "s3" : "s2");

export function RunnerModal({ run, onStop, onClose }: { run: RunState; onStop: () => void; onClose: () => void }) {
  const done = run.items.filter((i) => i.state === "done");
  const failedReq = done.filter((i) => i.error || i.failed > 0).length;
  const httpErrors = done.filter((i) => !i.error && !i.failed && (i.status ?? 0) >= 400).length;
  const tests = done.reduce((n, i) => n + i.passed + i.failed, 0);
  const failedTests = done.reduce((n, i) => n + i.failed, 0);
  const pct = run.items.length ? Math.round((done.length / run.items.length) * 100) : 0;
  return (
    <div className="scrim" onMouseDown={run.done ? onClose : undefined}>
      <div className="dialog runner" ref={focusScope} tabIndex={-1} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Run results">
        <h3>{run.title}</h3>
        <div className="run-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>
        <p className="run-summary">
          <b>{done.length}/{run.items.length}</b> requests
          <span className={failedReq ? "bad-text" : "ok-text"}>{failedReq ? `${failedReq} failed` : run.done ? "none failed" : ""}</span>
          {httpErrors > 0 && <span className="warn-text">{httpErrors} with an error status</span>}
          {tests > 0 && <span className={failedTests ? "bad-text" : "ok-text"}>{tests - failedTests}/{tests} tests passed</span>}
          {!run.done && <span className="muted">running…</span>}
        </p>
        <div className="runner-list">
          {run.items.map((i, k) => {
            const hardFail = !!i.error || i.failed > 0;
            const warn = i.state === "done" && !hardFail && (i.status ?? 0) >= 400;
            return (
              <div key={k} className={`run-row ${i.state} ${warn ? "warn" : ""}`}>
                <span className="run-ic">{i.state === "pending" ? "·" : i.state === "running" ? "…" : hardFail ? "✗" : warn ? "!" : "✓"}</span>
                <div className="run-main">
                  <div className="run-name">
                    <span className="run-title">{i.name}</span>
                    {i.state === "done" && !i.error && (
                      <span className="run-meta">
                        {i.passed + i.failed > 0 && <span className="muted">{i.passed}/{i.passed + i.failed} tests</span>}
                        <span className="muted">{i.ms} ms</span>
                        <span className={`pill ${statusClass(i.status ?? 0)}`}>{i.status}</span>
                      </span>
                    )}
                  </div>
                  {i.error && <div className="run-err">{i.error}</div>}
                  {i.failures.map((f, j) => <div key={j} className="run-err">{f}</div>)}
                </div>
              </div>
            );
          })}
        </div>
        <div className="dialog-actions">
          {run.done ? <button className="btn primary" onClick={onClose}>Close</button> : <button className="btn" onClick={onStop}>Stop</button>}
        </div>
      </div>
    </div>
  );
}
