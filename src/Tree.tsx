import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { TreeNode } from "./lib/types";
import { IconChevron, IconFolderSm, IconMore, IconPlus } from "./Icons";
import { Menu } from "./Menu";

/** Row height in px. Fixed, so the list can be virtualised: only the rows on screen exist in the DOM. */
export const ROW_HEIGHT = 28;
const OVERSCAN = 12;

type Props = {
  nodes: TreeNode[];
  activeFile: string | null;
  selectedDir: string;
  dirty: Set<string>;
  /** Method label per request file ("GET", "POST", "GQL"…), filled in lazily for the rows that are on screen. */
  labels: Record<string, string>;
  /** Called with the request files in (or near) the viewport, so their labels can be read. */
  onVisible: (paths: string[]) => void;
  onOpen: (path: string, pin?: boolean) => void;
  onSelectDir: (path: string) => void;
  onRun: (dir: string) => void;
  onDefaults: (dir: string) => void;
  onNewRequest: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRename: (node: TreeNode) => void;
  onDuplicate: (node: TreeNode) => void;
  onLink: (dir: string) => void;
  onUnlink: (node: TreeNode) => void;
  onDelete: (node: TreeNode) => void;
};

type Flat = { node: TreeNode; depth: number };

/** The rows that are currently visible: every folder's children, unless that folder is collapsed. */
function flatten(nodes: TreeNode[], collapsed: Set<string>, depth = 0, out: Flat[] = []): Flat[] {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.isDir && !collapsed.has(node.path)) flatten(node.children, collapsed, depth + 1, out);
  }
  return out;
}

/**
 * The collection tree. It handles tens of thousands of requests: the rows are laid out by index on a fixed
 * row height and only the window around the viewport is rendered.
 */
export function Tree(props: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rows = useMemo(() => flatten(props.nodes, collapsed), [props.nodes, collapsed]);
  const host = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ start: 0, end: 60 });
  const { onVisible, activeFile } = props;

  // The scrolling element is the sidebar body; work out which rows are inside it.
  useEffect(() => {
    const el = host.current;
    const scroller = el?.closest<HTMLElement>(".side-body");
    if (!el || !scroller) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const offset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      const first = Math.floor((scroller.scrollTop - offset) / ROW_HEIGHT);
      const count = Math.ceil(scroller.clientHeight / ROW_HEIGHT);
      const start = Math.max(0, first - OVERSCAN);
      const end = Math.min(rows.length, first + count + OVERSCAN);
      setWin((w) => (w.start === start && w.end === end ? w : { start, end }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", schedule);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [rows.length]);

  const shown = rows.slice(win.start, win.end);

  // Only the requests on screen need their method label.
  useEffect(() => {
    const paths = shown.filter((r) => !r.node.isDir).map((r) => r.node.path);
    if (paths.length) onVisible(paths);
  }, [win.start, win.end, rows, onVisible]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opening a request elsewhere (palette, history, a new file) brings its row into view.
  useEffect(() => {
    if (!activeFile) return;
    const i = rows.findIndex((r) => r.node.path === activeFile);
    const scroller = host.current?.closest<HTMLElement>(".side-body");
    if (i < 0 || !scroller || !host.current) return;
    const offset = host.current.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const top = offset + i * ROW_HEIGHT;
    if (top < scroller.scrollTop) scroller.scrollTop = top - ROW_HEIGHT;
    else if (top + ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + ROW_HEIGHT - scroller.clientHeight + ROW_HEIGHT;
  }, [activeFile]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  return (
    <div className="tree" role="tree" ref={host} style={{ height: rows.length * ROW_HEIGHT }}>
      {shown.map(({ node, depth }, k) => (
        <div key={node.path} className="tree-slot" style={{ top: (win.start + k) * ROW_HEIGHT }}>
          <Row node={node} depth={depth} open={!collapsed.has(node.path)} onToggle={toggle} {...props} />
        </div>
      ))}
    </div>
  );
}

type RowProps = Props & { node: TreeNode; depth: number; open: boolean; onToggle: (path: string) => void };

const Row = memo(function Row({ node, depth, open, onToggle, ...p }: RowProps) {
  const label = node.isDir ? node.name : node.name.replace(/\.req\.ya?ml$/, "");
  const isActive = !node.isDir && p.activeFile === node.path;
  const [method, linked] = (p.labels[node.path] ?? "").split("|");
  const btn = (title: string, icon: React.ReactNode, run: () => void) => (
    <button title={title} aria-label={title} onClick={run}>{icon}</button>
  );
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={node.isDir ? open : undefined}
      aria-selected={isActive}
      className={`tree-row ${isActive ? "on" : ""} ${node.isDir && p.selectedDir === node.path ? "sel" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => {
        if (node.isDir) {
          onToggle(node.path);
          p.onSelectDir(node.path);
        } else p.onOpen(node.path);
      }}
      onDoubleClick={() => !node.isDir && p.onOpen(node.path, true)}
    >
      {node.isDir ? (
        <>
          <span className={`chev ${open ? "open" : ""}`}><IconChevron /></span>
          <span className="tree-ico"><IconFolderSm /></span>
        </>
      ) : (
        <span className={`tree-method m-${method || "none"}`}>{method}</span>
      )}
      <span className="tree-label">
        {label}
        {linked && <span className="tree-link" title="Linked to a shared request: edits change the shared file" aria-label="linked">⛓</span>}
        {p.dirty.has(node.path) && <b className="unsaved" title="Unsaved changes">●</b>}
      </span>
      <span className="row-actions" onClick={(e) => e.stopPropagation()}>
        {node.isDir && btn("New request", <IconPlus />, () => p.onNewRequest(node.path))}
        <Menu
          title={`More actions for ${label}`}
          trigger={<IconMore />}
          items={
            node.isDir
              ? [
                  { label: "New folder", onClick: () => p.onNewFolder(node.path) },
                  { label: "Link a request…", hint: "reuse one defined elsewhere", onClick: () => p.onLink(node.path) },
                  { label: "Run folder", onClick: () => p.onRun(node.path) },
                  { label: "Folder settings…", hint: "variables, headers, auth, scripts", onClick: () => p.onDefaults(node.path) },
                  "sep",
                  { label: "Rename…", onClick: () => p.onRename(node) },
                  { label: "Delete", danger: true, onClick: () => p.onDelete(node) },
                ]
              : [
                  { label: "Duplicate", onClick: () => p.onDuplicate(node) },
                  ...(linked ? [{ label: "Make a separate copy", hint: "stop sharing", onClick: () => p.onUnlink(node) }] : []),
                  { label: "Rename…", onClick: () => p.onRename(node) },
                  "sep",
                  { label: "Delete", danger: true, onClick: () => p.onDelete(node) },
                ]
          }
        />
      </span>
    </div>
  );
});
