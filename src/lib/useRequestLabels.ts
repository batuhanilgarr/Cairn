import { useCallback, useRef, useState } from "react";
import { linkTarget } from "./collection";
import { readText } from "./fs";

const KIND_LABEL: Record<string, string> = { graphql: "GQL", ws: "WS", sse: "SSE", grpc: "gRPC", mcp: "MCP" };

/** "GET", "POST", "GQL"… from the head of a request file, without parsing the whole YAML. */
export function labelOf(yaml: string): string {
  const kind = yaml.match(/^type:\s*(\w+)/m)?.[1];
  if (kind && KIND_LABEL[kind]) return KIND_LABEL[kind];
  return (yaml.match(/^method:\s*([A-Za-z]+)/m)?.[1] ?? "GET").toUpperCase();
}

const BATCH = 24;

/**
 * Method labels for request files, read on demand. The tree asks for the rows that are on screen, so a
 * collection with thousands of requests reads a few dozen files, not all of them. The most recently asked-for
 * rows are read first (the user has scrolled on). `set` updates a label at once when a request is edited.
 */
export function useRequestLabels(): [Record<string, string>, (paths: string[]) => void, (path: string, label: string) => void] {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const seen = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const running = useRef(false);

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length) {
        const batch = queue.current.splice(0, BATCH);
        const texts = await Promise.all(batch.map((p) => readText(p).catch(() => null)));
        // a link shows the method of the request it points at, plus a marker the tree draws as a chain icon
        const labels = await Promise.all(
          texts.map(async (t, i) => {
            if (t === null) return null;
            const target = linkTarget(t, batch[i]);
            if (!target) return labelOf(t);
            const shared = await readText(target).catch(() => null);
            return (shared === null ? "?" : labelOf(shared)) + "|link";
          }),
        );
        setLabels((cur) => {
          const next = { ...cur };
          batch.forEach((p, i) => {
            if (labels[i] !== null) next[p] = labels[i]!;
          });
          return next;
        });
      }
    } finally {
      running.current = false;
    }
  }, []);

  const ensure = useCallback(
    (paths: string[]) => {
      const fresh = paths.filter((p) => !seen.current.has(p));
      if (!fresh.length) return;
      fresh.forEach((p) => seen.current.add(p));
      queue.current = [...fresh, ...queue.current];
      void pump();
    },
    [pump],
  );

  const set = useCallback((path: string, label: string) => {
    seen.current.add(path);
    setLabels((cur) => (cur[path] === label ? cur : { ...cur, [path]: label }));
  }, []);

  return [labels, ensure, set];
}
