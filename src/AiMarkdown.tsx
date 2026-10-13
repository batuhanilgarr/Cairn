import { useState } from "react";

/** The small part of Markdown model answers actually use: fenced code (with Copy), `inline code` and **bold**. Never injects HTML. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((p, i) =>
        p.startsWith("`") && p.endsWith("`") && p.length > 2 ? <code key={i}>{p.slice(1, -1)}</code> : p.startsWith("**") && p.endsWith("**") && p.length > 4 ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>,
      )}
    </>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ai-code">
      <div className="ai-code-bar">
        <span>{lang || "code"}</span>
        <button
          className="btn small"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{code}</pre>
    </div>
  );
}

export function AiMarkdown({ text }: { text: string }) {
  const parts = text.split(/```([\w+-]*)[ \t]*\n([\s\S]*?)(?:```|$)/g);
  const out: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    const prose = parts[i].replace(/^\n+|\n+$/g, "");
    if (prose) out.push(<p key={`p${i}`} className="ai-p"><Inline text={prose} /></p>);
    if (i + 2 < parts.length) out.push(<CodeBlock key={`c${i}`} lang={parts[i + 1]} code={parts[i + 2].replace(/\n$/, "")} />);
  }
  return <>{out}</>;
}
