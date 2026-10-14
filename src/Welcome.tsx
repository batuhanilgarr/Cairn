import { Logo } from "./Logo";
import { IconBraces, IconFolderPlus, IconGraph, IconImport, IconSend, IconTerminal } from "./Icons";

type Props = {
  hasCollection: boolean;
  onCurl: () => void;
  onSample: (kind: "get" | "post" | "graphql") => void;
  onNewCollection: () => void;
  onOpenCollection: () => void;
  onImport: () => void;
  onPalette: () => void;
  onSettings: () => void;
};

export function Welcome({ hasCollection, onCurl, onSample, onNewCollection, onOpenCollection, onImport, onPalette, onSettings }: Props) {
  return (
    <div className="welcome">
      <div className="welcome-head">
        <Logo size={44} />
        <div>
          <h2>Welcome to Cairn</h2>
          <p className="muted">A local-first API client. Your collections are plain files; no account, no cloud.</p>
        </div>
      </div>

      <div className="welcome-grid">
        <section>
          <h4>Start a request</h4>
          <button className="wcard" onClick={onCurl}>
            <span className="wicon"><IconTerminal /></span>
            <span className="wtext"><b>Paste a cURL command</b>
            <span>Click the URL bar and paste: method, headers, body and auth fill in.</span></span>
          </button>
          <button className="wcard" onClick={() => onSample("get")}>
            <span className="wicon"><IconSend /></span>
            <span className="wtext"><b>Try a sample GET</b>
            <span>Sends a request to a public test API so you can see a response.</span></span>
          </button>
          <button className="wcard" onClick={() => onSample("post")}>
            <span className="wicon"><IconBraces /></span>
            <span className="wtext"><b>Try a sample POST with JSON</b>
            <span>Body, content type and a JSON response, ready to edit.</span></span>
          </button>
          <button className="wcard" onClick={() => onSample("graphql")}>
            <span className="wicon"><IconGraph /></span>
            <span className="wtext"><b>Try a GraphQL query</b>
            <span>A public GraphQL API; fetch its schema for autocomplete and docs.</span></span>
          </button>
        </section>

        <section>
          <h4>Organize your work</h4>
          {!hasCollection && (
            <>
              <button className="wcard" onClick={onNewCollection}>
                <span className="wicon"><IconFolderPlus /></span>
                <span className="wtext"><b>New collection</b>
                <span>A folder of requests you can commit to Git.</span></span>
              </button>
              <button className="wcard" onClick={onOpenCollection}>
                <span className="wicon"><IconFolderPlus /></span>
                <span className="wtext"><b>Open a folder</b>
                <span>Use an existing collection, or turn any folder into one.</span></span>
              </button>
            </>
          )}
          <button className="wcard" onClick={onImport}>
            <span className="wicon"><IconImport /></span>
            <span className="wtext"><b>Import OpenAPI, Postman or Bruno</b>
            <span>{hasCollection ? "Bring requests in, with examples for the mock server." : "Create a collection first, then import into it."}</span></span>
          </button>
          <div className="wkeys">
            <button onClick={onPalette}><kbd>⌘K</kbd> Command palette</button>
            <button onClick={onSettings}><kbd>⌘,</kbd> Settings</button>
            <span><kbd>⌘↵</kbd> Send</span>
            <span><kbd>⌘S</kbd> Save</span>
            <span><kbd>⇧⌘G</kbd> Code</span>
            <span><kbd>⌘/</kbd> Shortcuts</span>
          </div>
        </section>
      </div>
      <p className="muted small welcome-foot">Tip: use <code>{"{{variables}}"}</code> anywhere, and <code>{"{{$guid}}"}</code> or <code>{"{{$timestamp}}"}</code> for fresh values. Pick or create an environment in the top right.</p>
    </div>
  );
}
