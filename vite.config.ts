import path from "node:path";
import { defineConfig } from "vite";

const repoRoot = __dirname;

export default defineConfig({
  root: "demo",
  base: "./",
  resolve: {
    alias: {
      "pdfjs": path.resolve(repoRoot, "pdf.js/src"),
      "#pdfjs": path.resolve(repoRoot, "pdf.js/src"),
      "display-node_utils": path.resolve(repoRoot, "pdf.js/src/display/node_utils.js"),
      "display-cmap_reader_factory": path.resolve(repoRoot, "pdf.js/src/display/cmap_reader_factory.js"),
      "display-standard_fontdata_factory": path.resolve(repoRoot, "pdf.js/src/display/standard_fontdata_factory.js"),
      "display-wasm_factory": path.resolve(repoRoot, "pdf.js/src/display/wasm_factory.js"),
      "display-fetch_stream": path.resolve(repoRoot, "pdf.js/src/display/fetch_stream.js"),
      "display-network": path.resolve(repoRoot, "pdf.js/src/display/network.js"),
      "display-node_stream": path.resolve(repoRoot, "pdf.js/src/display/node_stream.js"),
      "#platform/canvas": path.resolve(repoRoot, "src/platform/canvas.browser.ts"),
    },
  },
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
