import { useEffect, useRef } from "react";
import { Compartment, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext } from "@codemirror/autocomplete";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { xml } from "@codemirror/lang-xml";
import { html } from "@codemirror/lang-html";
import { tags as t } from "@lezer/highlight";

export type Lang = "json" | "js" | "xml" | "html" | "text";

/** Variable name -> value to show on hover (already masked for secrets). Missing = undefined variable. */
export type VarMap = Record<string, string>;

type Props = {
  value: string;
  onChange?: (v: string) => void;
  lang?: Lang;
  readOnly?: boolean;
  placeholder?: string;
  vars?: VarMap;
  wrap?: boolean;
  /** One line, no gutters: the URL bar. Enter calls onSubmit. */
  singleLine?: boolean;
  onSubmit?: () => void;
  /** Return true to swallow a paste (used to turn a pasted cURL command into a request). */
  onPasteText?: (text: string) => boolean;
  className?: string;
  /** Extra completions for the JS editor etc. */
  completions?: { label: string; detail?: string; type?: string }[];
  editorRef?: React.MutableRefObject<EditorView | null>;
  /** Extra extensions (e.g. a lazily loaded GraphQL language); swapped without recreating the editor. */
  extensions?: Extension;
};

/* ------------------------------- theme ------------------------------- */

const theme = EditorView.theme({
  "&": { color: "var(--text)", backgroundColor: "transparent", fontSize: "12px", height: "100%" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6", overflow: "auto" },
  ".cm-content": { caretColor: "var(--accent)", padding: "6px 0" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "28px" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)", outline: "none" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--hover)", border: "none", color: "var(--muted)" },
  ".cm-panels": { backgroundColor: "var(--bg-side)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-panel.cm-search input": { background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: "6px", color: "var(--text)", padding: "2px 6px" },
  ".cm-panel.cm-search button": { background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: "6px", color: "var(--text)", backgroundImage: "none", cursor: "pointer" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 35%, transparent)" },
  ".cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--accent) 45%, transparent)" },
  ".cm-tooltip": { backgroundColor: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "8px", boxShadow: "0 6px 24px rgba(0,0,0,.25)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)", color: "var(--text)" },
  ".cm-var": { borderRadius: "4px", padding: "0 1px" },
  ".cm-var-ok": { backgroundColor: "color-mix(in srgb, var(--ok) 20%, transparent)", color: "var(--ok)" },
  ".cm-var-missing": { backgroundColor: "color-mix(in srgb, var(--bad) 20%, transparent)", color: "var(--bad)" },
  ".cm-var-tip": { padding: "4px 10px", fontFamily: "var(--mono)", fontSize: "12px", maxWidth: "420px", whiteSpace: "pre-wrap", wordBreak: "break-all" },
  ".cm-placeholder": { color: "var(--muted)" },
});

const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.attributeName], color: "var(--j-key)" },
  { tag: [t.string, t.special(t.string)], color: "var(--j-str)" },
  { tag: [t.number, t.integer, t.float], color: "var(--j-num)" },
  { tag: [t.bool, t.null, t.keyword, t.operatorKeyword], color: "var(--j-bool)" },
  { tag: [t.tagName, t.typeName, t.className], color: "var(--j-key)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.definition(t.variableName)], color: "var(--j-key)" },
  { tag: t.punctuation, color: "var(--muted)" },
]);

/* --------------------------- {{variables}} --------------------------- */

const setVarsEffect = StateEffect.define<VarMap>();
const varsField = StateField.define<VarMap>({
  create: () => ({}),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setVarsEffect)) return e.value;
    return v;
  },
});

const VAR_RE = /\{\{\s*([\w.\-]+)\s*\}\}/g;

function buildVarDecos(view: EditorView): DecorationSet {
  const vars = view.state.field(varsField);
  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const m of text.matchAll(VAR_RE)) {
      const start = from + m.index!;
      const ok = Object.prototype.hasOwnProperty.call(vars, m[1]);
      ranges.push(Decoration.mark({ class: `cm-var ${ok ? "cm-var-ok" : "cm-var-missing"}` }).range(start, start + m[0].length));
    }
  }
  return Decoration.set(ranges, true);
}

const varDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildVarDecos(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(setVarsEffect)))) this.decorations = buildVarDecos(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const varHover = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos);
  for (const m of line.text.matchAll(VAR_RE)) {
    const from = line.from + m.index!;
    const to = from + m[0].length;
    if (pos >= from && pos <= to) {
      const vars = view.state.field(varsField);
      const has = Object.prototype.hasOwnProperty.call(vars, m[1]);
      return {
        pos: from,
        end: to,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "cm-var-tip";
          dom.textContent = has ? `${m[1]} = ${vars[m[1]] === "" ? "(empty)" : vars[m[1]]}` : `${m[1]} is not defined in the current environment`;
          return { dom };
        },
      };
    }
  }
  return null;
});

function varCompletions(ctx: CompletionContext) {
  const m = ctx.matchBefore(/\{\{\s*[\w.\-]*/);
  if (!m) return null;
  const vars = ctx.state.field(varsField);
  const closed = ctx.state.doc.sliceString(ctx.pos, ctx.pos + 2) === "}}";
  return {
    from: m.from + m.text.indexOf("{{") + 2 + (m.text.slice(m.text.indexOf("{{") + 2).match(/^\s*/)![0].length),
    options: Object.entries(vars).map(([k, v]) => ({ label: k, detail: v.length > 24 ? v.slice(0, 24) + "…" : v, type: "variable", apply: closed ? k : `${k}}}` })),
    validFor: /^[\w.\-]*$/,
  };
}

/* ------------------------------ component ------------------------------ */

const langExt = (lang: Lang): Extension => {
  switch (lang) {
    case "json": return json();
    case "js": return javascript();
    case "xml": return xml();
    case "html": return html();
    default: return [];
  }
};

export function CodeEditor({ value, onChange, lang = "text", readOnly, placeholder, vars, wrap, singleLine, onSubmit, onPasteText, className, completions, editorRef, extensions }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onSubmit, onPasteText });
  /** Values this editor reported via onChange that the parent hasn't echoed back yet. Echoes of our own edits must not be applied
   *  (React renders lag behind fast typing; applying a stale echo would erase newer keystrokes). */
  const pending = useRef<string[]>([]);
  cb.current = { onChange, onSubmit, onPasteText };
  const langC = useRef(new Compartment());
  const roC = useRef(new Compartment());
  const wrapC = useRef(new Compartment());
  const compC = useRef(new Compartment());
  const extC = useRef(new Compartment());

  useEffect(() => {
    const extra = (): Extension[] => {
      const base: Extension[] = [
        theme,
        syntaxHighlighting(highlight),
        varsField,
        varDecorations,
        varHover,
        drawSelection(),
        history(),
        closeBrackets(),
        bracketMatching(),
        indentOnInput(),
        cmPlaceholder(placeholder ?? ""),
        langC.current.of(langExt(lang)),
        extC.current.of(extensions ?? []),
        roC.current.of([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly)]),
        wrapC.current.of(wrap || singleLine ? EditorView.lineWrapping : []),
        // Sources are added through language data (not `override`), so they sit alongside the language's own
        // completions, e.g. GraphQL schema fields.
        compC.current.of([
          autocompletion({ icons: false }),
          EditorState.languageData.of(() => [{ autocomplete: varCompletions }]),
          ...(completions?.length
            ? [
                EditorState.languageData.of(() => [
                  {
                    autocomplete: (c: CompletionContext) => {
                      const w = c.matchBefore(/[\w.]+/);
                      if (!w || (w.from === w.to && !c.explicit)) return null;
                      return { from: w.from, options: completions };
                    },
                  },
                ]),
              ]
            : []),
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            const text = u.state.doc.toString();
            pending.current.push(text);
            cb.current.onChange?.(text);
          }
        }),
        EditorView.domEventHandlers({
          paste(e) {
            const text = e.clipboardData?.getData("text");
            if (text && cb.current.onPasteText?.(text)) {
              e.preventDefault();
              return true;
            }
            return false;
          },
        }),
      ];
      if (singleLine) {
        base.push(
          EditorState.transactionFilter.of((tr) => (tr.docChanged && tr.newDoc.lines > 1 ? [{ changes: { from: 0, to: tr.startState.doc.length, insert: tr.newDoc.toString().replace(/\s*\n\s*/g, " ") }, selection: { anchor: tr.newDoc.toString().replace(/\s*\n\s*/g, " ").length } }] : tr)),
          keymap.of([{ key: "Enter", run: () => (cb.current.onSubmit?.(), true) }]),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap]),
          EditorView.contentAttributes.of({ spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
        );
      } else {
        base.push(
          lineNumbers(),
          foldGutter({ openText: "▾", closedText: "▸" }),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
          EditorView.contentAttributes.of({ spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
        );
      }
      return base;
    };

    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: value, extensions: extra() }),
    });
    v.dispatch({ effects: setVarsEffect.of(vars ?? {}) });
    view.current = v;
    if (editorRef) editorRef.current = v;
    return () => {
      v.destroy();
      view.current = null;
      if (editorRef) editorRef.current = null;
    };
    // The editor is created once; props below are synced by the effects that follow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singleLine]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const i = pending.current.indexOf(value);
    if (i >= 0) {
      pending.current.splice(0, i + 1); // our own edit coming back: nothing to do
      return;
    }
    pending.current = [];
    if (v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => view.current?.dispatch({ effects: langC.current.reconfigure(langExt(lang)) }), [lang]);
  useEffect(() => view.current?.dispatch({ effects: roC.current.reconfigure([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly)]) }), [readOnly]);
  useEffect(() => view.current?.dispatch({ effects: wrapC.current.reconfigure(wrap || singleLine ? EditorView.lineWrapping : []) }), [wrap, singleLine]);
  useEffect(() => view.current?.dispatch({ effects: setVarsEffect.of(vars ?? {}) }), [vars]);
  useEffect(() => view.current?.dispatch({ effects: extC.current.reconfigure(extensions ?? []) }), [extensions]);

  return <div ref={host} className={`cm-host ${singleLine ? "single" : ""} ${className ?? ""}`} />;
}
