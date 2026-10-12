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

export function RunnerModal({ run, onStop, onClose }: { run: RunState; onStop: () => void; onClose: () => void }) {
  const done = run.items.filter((i) => i.state === "done");
  const failedReq = done.filter((i) => i.error || i.failed > 0).length;
  const tests = done.reduce((n, i) => n + i.passed + i.failed, 0);
  const failedTests = done.reduce((n, i) => n + i.failed, 0);
  return (
    <div className="scrim" onMouseDown={run.done ? onClose : undefined}>
      <div className="dialog runner" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Run results">
        <h3>{run.title}</h3>
        <div className="runner-list">
          {run.items.map((i, k) => (
            <div key={k} className={`run-row ${i.state}`}>
              <span className="run-ic">{i.state === "pending" ? "·" : i.state === "running" ? "…" : i.error || i.failed ? "✗" : "✓"}</span>
              <div className="run-main">
                <div className="run-name">
                  {i.name}
                  {i.state === "done" && !i.error && (
                    <span className="muted"> · {i.status} · {i.ms} ms{i.passed + i.failed ? ` · ${i.passed}/${i.passed + i.failed} tests` : ""}</span>
                  )}
                </div>
                {i.error && <div className="run-err">{i.error}</div>}
                {i.failures.map((f, j) => <div key={j} className="run-err">{f}</div>)}
              </div>
            </div>
          ))}
        </div>
        <p className="muted">
          {run.done ? "Finished" : "Running…"} · {done.length}/{run.items.length} requests · {failedReq} failed · {tests - failedTests}/{tests} tests passed
        </p>
        <div className="dialog-actions">
          {run.done ? <button className="btn primary" onClick={onClose}>Close</button> : <button className="btn" onClick={onStop}>Stop</button>}
        </div>
      </div>
    </div>
  );
}
