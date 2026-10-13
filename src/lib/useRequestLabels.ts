import { useEffect, useRef, useState } from "react";
import { readText } from "./fs";
import type { TreeNode } from "./types";

const KIND_LABEL: Record<string, string> = { graphql: "GQL", ws: "WS", sse: "SSE", grpc: "gRPC", mcp: "MCP" };

/** "GET", "POST", "GQL"… from the head of a request file, without parsing the whole YAML. */
export function labelOf(yaml: string): string {
  const kind = yaml.match(/^type:\s*(\w+)/m)?.[1];
  if (kind && KIND_LABEL[kind]) return KIND_LABEL[kind];
  return (yaml.match(/^method:\s*([A-Za-z]+)/m)?.[1] ?? "GET").toUpperCase();
}

const filesOf = (nodes: TreeNode[]): string[] => nodes.flatMap((n) => (n.isDir ? filesOf(n.children) : [n.path]));

/**
 * The method label of every request in the tree, read in the background in small batches so a big collection
 * doesn't stall the sidebar. `set` lets the app update a label right away when a request is edited or saved.
 */
export function useRequestLabels(tree: TreeNode[]): [Record<string, string>, (path: string, label: string) => void] {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const seen = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    const todo = filesOf(tree).filter((p) => !seen.current.has(p));
    todo.forEach((p) => seen.current.add(p));
    (async () => {
      for (let i = 0; i < todo.length && live; i += 24) {
        const batch = todo.slice(i, i + 24);
        const texts = await Promise.all(batch.map((p) => readText(p).catch(() => null)));
        if (!live) return;
        setLabels((cur) => {
          const next = { ...cur };
          batch.forEach((p, j) => {
            if (texts[j] !== null) next[p] = labelOf(texts[j]!);
          });
          return next;
        });
      }
    })();
    return () => {
      live = false;
    };
  }, [tree]);

  const set = (path: string, label: string) => setLabels((cur) => (cur[path] === label ? cur : { ...cur, [path]: label }));
  return [labels, set];
}
