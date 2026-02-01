import path from "node:path";
import { defineConfig } from "vite";

const repoRoot = __dirname;

export default defineConfig({
  root: "demo",
  base: "./",
  resolve: {
    alias: {
      "#pdfjs": path.resolve(repoRoot, "pdf.js/src"),
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
