import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shim = (f) => path.join(here, "shims", f);

await build({
  entryPoints: [path.join(here, "src/main.ts")],
  outfile: path.join(here, "dist/cairn.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  alias: {
    "@tauri-apps/api/core": shim("tauri-core.ts"),
    "@tauri-apps/plugin-dialog": shim("plugin-dialog.ts"),
    "@tauri-apps/plugin-opener": shim("plugin-opener.ts"),
  },
  plugins: [
    {
      // The app runs scripts in a browser Worker; the CLI uses a worker thread with the same harness.
      name: "node-script-runner",
      setup(b) {
        b.onResolve({ filter: /^\.\/script$/ }, () => ({ path: shim("script-node.ts") }));
      },
    },
  ],
  logLevel: "info",
  minify: false,
});
