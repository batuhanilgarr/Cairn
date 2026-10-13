import { useState } from "react";
import type { TreeNode } from "./lib/types";
import { IconChevron, IconCopy, IconFolderPlus, IconFolderSm, IconGearSm, IconPencil, IconPlay, IconPlus, IconTrash } from "./Icons";

type Props = {
  nodes: TreeNode[];
  activeFile: string | null;
  selectedDir: string;
  dirty: Set<string>;
  /** Method label per request file ("GET", "POST", "GQL"…). */
  labels: Record<string, string>;
  onOpen: (path: string) => void;
  onSelectDir: (path: string) => void;
  onRun: (dir: string) => void;
  onDefaults: (dir: string) => void;
  onNewRequest: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRename: (node: TreeNode) => void;
  onDuplicate: (node: TreeNode) => void;
  onDelete: (node: TreeNode) => void;
};

export function Tree(props: Props) {
  return (
    <div className="tree" role="tree">
      {props.nodes.map((n) => (
        <Row key={n.path} node={n} depth={0} {...props} />
      ))}
    </div>
  );
}

function Row({ node, depth, ...p }: Props & { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(true);
  const label = node.isDir ? node.name : node.name.replace(/\.req\.ya?ml$/, "");
  const isActive = !node.isDir && p.activeFile === node.path;
  const method = p.labels[node.path];
  const btn = (title: string, icon: React.ReactNode, run: () => void) => (
    <button title={title} aria-label={title} onClick={run}>{icon}</button>
  );
  return (
    <>
      <div
        role="treeitem"
        aria-expanded={node.isDir ? open : undefined}
        aria-selected={isActive}
        className={`tree-row ${isActive ? "on" : ""} ${node.isDir && p.selectedDir === node.path ? "sel" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          if (node.isDir) {
            setOpen(!open);
            p.onSelectDir(node.path);
          } else p.onOpen(node.path);
        }}
      >
        {node.isDir ? (
          <>
            <span className={`chev ${open ? "open" : ""}`}><IconChevron /></span>
            <span className="tree-ico"><IconFolderSm /></span>
          </>
        ) : (
          <span className={`tree-method m-${method ?? "none"}`}>{method ?? ""}</span>
        )}
        <span className="tree-label">
          {label}
          {p.dirty.has(node.path) && <b className="unsaved" title="Unsaved changes">●</b>}
        </span>
        <span className="row-actions" onClick={(e) => e.stopPropagation()}>
          {node.isDir && (
            <>
              {btn("New request", <IconPlus />, () => p.onNewRequest(node.path))}
              {btn("New folder", <IconFolderPlus />, () => p.onNewFolder(node.path))}
              {btn("Run folder", <IconPlay />, () => p.onRun(node.path))}
              {btn("Folder defaults: variables, headers, auth, scripts", <IconGearSm />, () => p.onDefaults(node.path))}
            </>
          )}
          {!node.isDir && btn("Duplicate", <IconCopy />, () => p.onDuplicate(node))}
          {btn("Rename", <IconPencil />, () => p.onRename(node))}
          {btn("Delete", <IconTrash />, () => p.onDelete(node))}
        </span>
      </div>
      {node.isDir && open && node.children.map((c) => <Row key={c.path} node={c} depth={depth + 1} {...p} />)}
    </>
  );
}
