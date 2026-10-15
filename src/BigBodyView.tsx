import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { bodyLines, bodyPrepare, bodySearch, type Found, type Prepared } from "./lib/bigbody";

/**
 * Viewer for responses too big to hand to the page (the body stays in Rust). Only the visible lines
 * are fetched and drawn, so a 100 MB response costs a few dozen DOM nodes. Browsers cap an element's
 * height at roughly 33M px, so past 8M px the scrollbar maps proportionally onto the line range.
 */
export const LINE_HEIGHT = 19;
const MAX_SCROLL_PX = 8_000_000;
const OVERSCAN = 20;

/** Set while a big viewer is mounted so ⌘F can focus its search box. */
export const bigFind: { focus: (() => void) | null } = { focus: null };

const TOKEN = /("(?:[^"\\]|\\.)*"(?=\s*:))|("(?:[^"\\]|\\.)*"?)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
const CLASS = ["", "j-k", "j-s", "j-n", "j-b"];

type Tok = { t: string; c: string; hit?: boolean };

/** Colour one line of JSON; plain text and long lines are left alone. */
function colour(line: string, json: boolean): Tok[] {
  if (!json || line.length > 600) return [{ t: line, c: "" }];
  const out: Tok[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ t: line.slice(last, i), c: "" });
    out.push({ t: m[0], c: CLASS[m.findIndex((x, n) => n > 0 && x !== undefined)] });
    last = i + m[0].length;
  }
  if (last < line.length) out.push({ t: line.slice(last), c: "" });
  return out;
}

function mark(parts: Tok[], q: string, cs: boolean): Tok[] {
  if (!q) return parts;
  const needle = cs ? q : q.toLowerCase();
  const out: Tok[] = [];
  for (const p of parts) {
    const hay = cs ? p.t : p.t.toLowerCase();
    let at = 0;
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, at)) {
      if (i > at) out.push({ t: p.t.slice(at, i), c: p.c });
      out.push({ t: p.t.slice(i, i + needle.length), c: p.c, hit: true });
      at = i + needle.length;
    }
    if (at < p.t.length) out.push({ t: p.t.slice(at), c: p.c });
  }
  return out;
}

const Line = memo(function Line({ n, text, json, q, cs, current, gutter }: { n: number; text: string; json: boolean; q: string; cs: boolean; current: boolean; gutter: number }) {
  return (
    <div className={`big-line ${current ? "cur" : ""}`} style={{ height: LINE_HEIGHT }}>
      <span className="big-ln" style={{ width: `${gutter}ch` }}>{n + 1}</span>
      <span className="big-tx">
        {mark(colour(text, json), q, cs).map((k, i) => (k.hit ? <mark key={i} className={k.c}>{k.t}</mark> : k.c ? <span key={i} className={k.c}>{k.t}</span> : k.t))}
      </span>
    </div>
  );
});

export function BigBodyView({ id, json, onPrepared }: { id: number; json: boolean; onPrepared?: (p: Prepared) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLInputElement>(null);
  const [info, setInfo] = useState<Prepared | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [view, setView] = useState({ h: 400, top: 0 });
  const [page, setPage] = useState<{ start: number; lines: string[] }>({ start: 0, lines: [] });
  const [query, setQuery] = useState("");
  const [cs, setCs] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const [at, setAt] = useState(0);
  const ticket = useRef(0);
  const searchTicket = useRef(0);

  useEffect(() => {
    let live = true;
    setInfo(null);
    setFailed(null);
    setPage({ start: 0, lines: [] });
    setFound(null);
    setQuery("");
    bodyPrepare(id)
      .then((p) => {
        if (!live) return;
        setInfo(p);
        onPrepared?.(p);
      })
      .catch((e) => live && setFailed(String(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    bigFind.focus = () => {
      find.current?.focus();
      find.current?.select();
    };
    return () => {
      bigFind.focus = null;
    };
  }, []);

  const lines = info?.lines ?? 0;
  // At the end of the scroll the last line must sit fully inside the window, whatever the window height is.
  const visible = Math.ceil(view.h / LINE_HEIGHT) + 1;
  const rowsFit = Math.max(1, Math.floor(view.h / LINE_HEIGHT));
  const lastFirst = Math.max(0, lines - rowsFit);
  const fullPx = lastFirst * LINE_HEIGHT + view.h;
  const scaled = fullPx > MAX_SCROLL_PX;
  const spacer = scaled ? MAX_SCROLL_PX : fullPx;
  const maxScroll = Math.max(1, spacer - view.h);
  const first = scaled ? Math.min(lastFirst, Math.round((view.top / maxScroll) * lastFirst)) : Math.min(lastFirst, Math.floor(view.top / LINE_HEIGHT));

  const measure = useCallback(() => {
    const el = box.current;
    if (el) setView((v) => (v.h === el.clientHeight && v.top === el.scrollTop ? v : { h: el.clientHeight, top: el.scrollTop }));
  }, []);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    measure();
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [measure, info]);

  // fetch the lines around the viewport (the previous page stays on screen until the new one lands)
  useEffect(() => {
    if (!info || lines === 0) return;
    const start = Math.max(0, first - OVERSCAN);
    const count = Math.min(lines - start, visible + 2 * OVERSCAN);
    if (page.lines.length && start >= page.start && start + count <= page.start + page.lines.length) return;
    const mine = ++ticket.current;
    bodyLines(id, start, count)
      .then((ls) => mine === ticket.current && setPage({ start, lines: ls }))
      .catch((e) => mine === ticket.current && setFailed(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, first, visible, id]);

  const scrollToLine = useCallback(
    (n: number) => {
      const el = box.current;
      if (!el || !lines) return;
      const target = Math.max(0, n - Math.floor(visible / 3));
      el.scrollTop = scaled ? (target / Math.max(1, lastFirst)) * maxScroll : target * LINE_HEIGHT;
    },
    [lines, visible, scaled, lastFirst, maxScroll],
  );

  // run the search (debounced) when the text or case option changes
  useEffect(() => {
    if (!query) {
      setFound(null);
      return;
    }
    const mine = ++searchTicket.current;
    const t = setTimeout(() => {
      bodySearch(id, query, cs)
        .then((f) => {
          if (mine !== searchTicket.current) return;
          setFound(f);
          setAt(0);
          if (f.lines.length) scrollToLine(f.lines[0]);
        })
        .catch(() => undefined);
    }, 160);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, cs, id]);

  const step = (d: number) => {
    if (!found?.lines.length) return;
    const n = (at + d + found.lines.length) % found.lines.length;
    setAt(n);
    scrollToLine(found.lines[n]);
  };

  const gutter = String(lines).length;
  const currentLine = found?.lines[at];
  const offset = page.start - first;

  if (failed) return <p className="muted small" role="alert">Couldn't read this response: {failed}</p>;
  return (
    <div className="big-body">
      <div className="big-find">
        <input
          ref={find}
          className="big-q"
          type="search"
          placeholder="Search this response"
          aria-label="Search this response"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            }
          }}
        />
        <button className={`btn small ${cs ? "on" : ""}`} aria-pressed={cs} onClick={() => setCs(!cs)} title="Match case">Aa</button>
        <span className="big-count muted small" aria-live="polite">
          {query && found ? (found.total ? `${at + 1} of ${found.total.toLocaleString()}${found.capped ? "+" : ""}` : "No matches") : info ? `${lines.toLocaleString()} lines` : "Reading…"}
        </span>
        <button className="btn small" onClick={() => step(-1)} disabled={!found?.total} aria-label="Previous match">↑</button>
        <button className="btn small" onClick={() => step(1)} disabled={!found?.total} aria-label="Next match">↓</button>
      </div>
      <div className="big-scroll" ref={box} role="region" aria-label="Response body" tabIndex={0}>
        <div className="big-spacer" style={{ height: spacer }}>
          <div className="big-stick" style={{ height: view.h }}>
            <div style={{ transform: `translateY(${offset * LINE_HEIGHT}px)` }}>
              {page.lines.map((text, i) => (
                <Line key={page.start + i} n={page.start + i} text={text} json={json || !!info?.pretty} q={query} cs={cs} current={page.start + i === currentLine} gutter={gutter} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
