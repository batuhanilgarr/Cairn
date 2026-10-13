import { useEffect, useMemo, useRef, useState } from "react";
import { AiMarkdown } from "./AiMarkdown";
import { buildContext, chat, splitThinking, systemMessage, type AiConfig } from "./lib/ai";
import type { RequestTab, ResponseData } from "./lib/types";

type Msg = { role: "user" | "assistant"; content: string; error?: boolean };

type Props = {
  config: AiConfig;
  /** The request as it will be sent: inherited headers and auth applied, {{variables}} still unresolved. */
  tab: RequestTab;
  response: ResponseData | null;
  /** Set when the last send failed before any response arrived. */
  sendError?: string;
  tabs: React.ReactNode;
  onSettings: () => void;
};

const host = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/.*$/, "");

/** Ask a model about the request you have open. The conversation is kept per tab; the request is re-read on every question. */
export function AiPanel({ config, tab, response, sendError, tabs, onSettings }: Props) {
  const [convos, setConvos] = useState<Record<string, Msg[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [incBody, setIncBody] = useState(true);
  const [incResp, setIncResp] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  const msgs = convos[tab.id] ?? [];
  const ready = config.baseUrl.trim() !== "" && config.model.trim() !== "";
  const failed = !!sendError || (!!response && response.status >= 400);

  const context = useMemo(() => {
    const base = buildContext(tab, response, { body: incBody, response: incResp });
    return incResp && sendError ? `${base}\n\nThe last send failed before any response arrived: ${sendError}` : base;
  }, [tab, response, incBody, incResp, sendError]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [msgs.length, busy]);

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || busy || !ready) return;
    const id = tab.id;
    const next: Msg[] = [...(convos[id] ?? []), { role: "user", content: q }];
    setConvos((c) => ({ ...c, [id]: next }));
    setDraft("");
    setBusy(id);
    try {
      const reply = await chat(config, [systemMessage(context), ...next.filter((m) => !m.error).map(({ role, content }) => ({ role, content }))]);
      setConvos((c) => ({ ...c, [id]: [...next, { role: "assistant", content: reply }] }));
    } catch (e) {
      setConvos((c) => ({ ...c, [id]: [...next, { role: "assistant", content: String((e as Error).message ?? e), error: true }] }));
    } finally {
      setBusy(null);
    }
  };

  const chips = [
    ...(failed ? ["Why did this request fail, and how do I fix it?"] : []),
    "Explain what this request does and what each parameter means.",
    ...(response ? ["Write test assertions for this response."] : []),
    "Show an example request body for this endpoint.",
  ];

  return (
    <aside className="codepanel ai" aria-label="AI assistant">
      {tabs}
      <div className="ai-head">
        {ready ? (
          <span className="ai-model" title={`${config.model} on ${config.baseUrl}`}><b>{config.model}</b> · {host(config.baseUrl)}</span>
        ) : (
          <span className="muted">No model set up</span>
        )}
        <div className="spacer" />
        {msgs.length > 0 && <button className="btn small" onClick={() => setConvos((c) => ({ ...c, [tab.id]: [] }))}>Clear</button>}
        <button className="btn small" onClick={onSettings}>Settings</button>
      </div>

      <div className="ai-msgs">
        {!ready ? (
          <div className="ai-empty">
            <p><b>Ask about this request.</b></p>
            <p className="muted">Connect your own model first: Ollama, or any OpenAI-compatible server. You can paste the curl command you already use.</p>
            <button className="btn primary" onClick={onSettings}>Set up an AI endpoint</button>
          </div>
        ) : msgs.length === 0 ? (
          <div className="ai-empty">
            <p><b>Ask about this request.</b></p>
            <p className="muted">The model sees the method, URL, headers and body{response ? ", and the last response" : ""}. Credentials stay hidden.</p>
            <div className="ai-chips">{chips.map((c) => <button key={c} className="ai-chip" onClick={() => void ask(c)}>{c}</button>)}</div>
          </div>
        ) : (
          msgs.map((m, i) => {
            if (m.role === "user") return <div key={i} className="ai-user">{m.content}</div>;
            if (m.error) return <div key={i} className="ai-error" role="alert">{m.content}</div>;
            const { answer, thinking } = splitThinking(m.content);
            return (
              <div key={i} className="ai-bot">
                {thinking && <details className="ai-think"><summary>Reasoning</summary><p>{thinking}</p></details>}
                <AiMarkdown text={answer || "(empty answer)"} />
              </div>
            );
          })
        )}
        {busy === tab.id && <div className="ai-bot muted" role="status">Thinking…</div>}
        <div ref={end} />
      </div>

      <div className="ai-compose">
        <div className="ai-opts">
          <label className="check small"><input type="checkbox" checked={incBody} onChange={(e) => setIncBody(e.target.checked)} /> Request body</label>
          <label className="check small" title={response || sendError ? "" : "Send the request first"}><input type="checkbox" checked={incResp} disabled={!response && !sendError} onChange={(e) => setIncResp(e.target.checked)} /> Last response</label>
        </div>
        <div className="ai-box">
          <textarea
            value={draft}
            placeholder={ready ? "Ask about this request…" : "Set up an endpoint in Settings > AI"}
            disabled={!ready}
            rows={2}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void ask(draft);
              }
            }}
          />
          <button className="btn primary" disabled={!ready || !draft.trim() || !!busy} onClick={() => void ask(draft)}>Ask</button>
        </div>
        <details className="ai-seen">
          <summary>What the model sees</summary>
          <pre>{context}</pre>
        </details>
      </div>
    </aside>
  );
}
