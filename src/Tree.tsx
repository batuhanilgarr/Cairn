import { useState } from "react";
import type { TreeNode } from "./lib/types";

type Props = {
  nodes: TreeNode[];
  activeFile: string | null;
  selectedDir: string;
  dirty: Set<string>;
  onOpen: (path: string) => void;
  onSelectDir: (path: string) => void;
  onNewRequest: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRename: (node: TreeNode) => void;
  onDuplicate: (node: TreeNode) => void;
  onDelete: (node: TreeNode) => void;
};

export function Tree(props: Props) {
  return (
    <div className="tree">
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
  return (
    <>
      <div
        className={`tree-row ${isActive ? "on" : ""} ${node.isDir && p.selectedDir === node.path ? "sel" : ""}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => {
          if (node.isDir) {
            setOpen(!open);
            p.onSelectDir(node.path);
          } else p.onOpen(node.path);
        }}
      >
        <span className="chev">{node.isDir ? (open ? "▾" : "▸") : ""}</span>
        <span className="tree-label">
          {label}
          {p.dirty.has(node.path) && <b className="unsaved">●</b>}
        </span>
        <span className="row-actions" onClick={(e) => e.stopPropagation()}>
          {node.isDir && (
            <>
              <button title="New request" onClick={() => p.onNewRequest(node.path)}>＋</button>
              <button title="New folder" onClick={() => p.onNewFolder(node.path)}>▤</button>
            </>
          )}
          {!node.isDir && <button title="Duplicate" onClick={() => p.onDuplicate(node)}>⧉</button>}
          <button title="Rename" onClick={() => p.onRename(node)}>✎</button>
          <button title="Delete" onClick={() => p.onDelete(node)}>🗑</button>
        </span>
      </div>
      {node.isDir && open && node.children.map((c) => <Row key={c.path} node={c} depth={depth + 1} {...p} />)}
    </>
  );
}
