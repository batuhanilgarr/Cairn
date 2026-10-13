import { useState } from "react";
import { chat, configFromCurl, listModels, type AiConfig } from "./lib/ai";

type Props = { ai: AiConfig; onChange: (ai: AiConfig) => void };
type Status = { kind: "idle" | "busy" | "ok" | "error"; text: string };

/** Settings > AI: where the assistant sends its questions. Works with OpenAI-compatible servers and with Ollama. */
export function AiSettings({ ai, onChange }: Props) {
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle", text: "" });
  const [curl, setCurl] = useState("");
  const set = (p: Partial<AiConfig>) => onChange({ ...ai, ...p });

  const run = async (label: string, fn: () => Promise<string>) => {
    setStatus({ kind: "busy", text: label });
    try {
      setStatus({ kind: "ok", text: await fn() });
    } catch (e) {
      setStatus({ kind: "error", text: String((e as Error).message ?? e) });
    }
  };

  const row = (label: string, hint: string | undefined, control: React.ReactNode) => (
    <div className="set-row">
      <div className="set-label">{label}{hint && <span>{hint}</span>}</div>
      <div className="set-control">{control}</div>
    </div>
  );

  return (
    <>
      <h2>AI assistant</h2>
      <p className="muted small">
        Ask questions about the request you have open. Questions go straight from this Mac to the endpoint below. The model sees the request and, if you allow it, the last response, with credentials and
        <code>{"{{variables}}"}</code> hidden or left unresolved.
      </p>
      {row("Server type", "Ollama's own API, or any OpenAI-compatible server (OpenAI, OpenRouter, LM Studio, vLLM, Groq…).", (
        <select value={ai.format} onChange={(e) => { setModels([]); set({ format: e.target.value as AiConfig["format"] }); }}>
          <option value="ollama">Ollama</option>
          <option value="openai">OpenAI-compatible</option>
        </select>
      ))}
      {row("Endpoint", ai.format === "ollama" ? "The server root. Pasting …/api/generate works too." : "The base URL, usually ending in /v1.", (
        <input className="cell" placeholder={ai.format === "ollama" ? "https://ollama.example.com" : "https://api.openai.com/v1"} value={ai.baseUrl} spellCheck={false} onChange={(e) => set({ baseUrl: e.target.value })} />
      ))}
      {row("Token", "Optional. Leave empty when the server needs none. Stored on this Mac, never in a collection.", (
        <input className="cell" type="password" placeholder="No token" value={ai.token} spellCheck={false} autoComplete="off" onChange={(e) => set({ token: e.target.value })} />
      ))}
      {ai.token.trim() !== "" && row("Auth header", "Sent as “name: scheme token”. Clear the scheme to send the bare token.", (
        <div className="path-field">
          <input className="cell" value={ai.authHeader} spellCheck={false} onChange={(e) => set({ authHeader: e.target.value })} aria-label="Header name" />
          <input className="cell narrow" value={ai.authScheme} placeholder="Bearer" spellCheck={false} onChange={(e) => set({ authScheme: e.target.value })} aria-label="Scheme" />
        </div>
      ))}
      {row("Model", "Fetch the list from the server, or type a name.", (
        <div className="path-field">
          <input className="cell" list="ai-models" placeholder="e.g. qwen3:8b" value={ai.model} spellCheck={false} onChange={(e) => set({ model: e.target.value })} />
          <datalist id="ai-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
          <button
            className="btn small"
            disabled={status.kind === "busy" || !ai.baseUrl.trim()}
            onClick={() => void run("Fetching models…", async () => {
              const list = await listModels(ai);
              setModels(list);
              if (!ai.model && list[0]) set({ model: list[0] });
              return list.length ? `${list.length} model${list.length === 1 ? "" : "s"} found. Pick one in the Model field.` : "The server has no models listed.";
            })}
          >
            Fetch models
          </button>
        </div>
      ))}
      {models.length > 0 && row("Available", undefined, (
        <select value={models.includes(ai.model) ? ai.model : ""} onChange={(e) => e.target.value && set({ model: e.target.value })}>
          <option value="">Choose…</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      ))}
      {row("Skip reasoning", "Adds “/no_think” to each question (Qwen3 and similar models answer faster).", (
        <label className="switch"><input type="checkbox" checked={ai.noThink} onChange={(e) => set({ noThink: e.target.checked })} /><span /></label>
      ))}
      {row("Test", undefined, (
        <button className="btn" disabled={status.kind === "busy" || !ai.baseUrl.trim() || !ai.model.trim()} onClick={() => void run("Asking the model…", async () => `The model answered: “${(await chat(ai, [{ role: "user", content: "Reply with the single word: ready" }])).replace(/<think>[\s\S]*?<\/think>/g, "").trim().slice(0, 80)}”`)}>
          Send a test question
        </button>
      ))}
      {status.kind !== "idle" && <p className={status.kind === "error" ? "err" : status.kind === "ok" ? "ok-text" : "muted"} role="status">{status.text}</p>}

      <h4 style={{ marginTop: 22 }}>Fill from a curl command</h4>
      <p className="muted small">Paste the curl you already use to call your model. The endpoint, model and token are taken from it.</p>
      <textarea className="editor" style={{ minHeight: 90 }} spellCheck={false} placeholder={"curl 'https://ollama.example.com/api/generate' --data '{\"model\": \"qwen3:8b\", …}'"} value={curl} onChange={(e) => setCurl(e.target.value)} />
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="btn"
          disabled={!curl.trim()}
          onClick={() => {
            try {
              const { notes, ...cfg } = configFromCurl(curl);
              onChange({ ...ai, ...cfg });
              setModels([]);
              setCurl("");
              setStatus({ kind: "ok", text: `Settings filled in${notes.length ? `. ${notes.join(" ")}` : "."}` });
            } catch (e) {
              setStatus({ kind: "error", text: String((e as Error).message ?? e) });
            }
          }}
        >
          Use this command
        </button>
      </div>
    </>
  );
}
