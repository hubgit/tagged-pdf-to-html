import path from "node:path";
import { defineConfig } from "vitest/config";

const repoRoot = __dirname;

export default defineConfig({
  resolve: {
    alias: {
      "#pdfjs": path.resolve(repoRoot, "pdf.js/src"),
    },
  },
  test: {
    include: ["test/**"]
  }
});
