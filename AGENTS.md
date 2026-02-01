# Agent Guide for Tagged PDF to HTML

This document provides essential information for AI agents working on this codebase.

## Project Overview

This project implements the "Deriving HTML from PDF" algorithm (PDF Association Specification) using TypeScript and `pdf.js`. It converts Tagged PDF documents into semantic HTML5 with CSS.

**Core Goal:** Deterministic, spec-compliant conversion of PDF structure trees to HTML.

## Key Files & Directories

- **`SPECIFICATION.md`**: The authoritative source for all logic. **Read this first.** Code comments should reference section numbers (e.g., `// §4.2.1`).
- **`src/index.ts`**: Public API entry point (`deriveHtmlFromPdf`).
- **`src/converter.ts`**: Main orchestration logic (HTML shell, metadata, CSS generation, script injection).
- **`src/structure_traversal.ts`**: Recursive traversal of the PDF structure tree (the heart of the conversion).
- **`src/pdf_js_context.ts`**: Helper to initialize `pdf.js` context from raw data.
- **`pdf.js/`**: A submodule containing the `pdf.js` source code. We import directly from source files (e.g., `../pdf.js/src/core/...`).
- **`test/`**: Contains `vitest` specs.

## Development Workflow

### Building
The project uses `tsdown` for building.
```bash
npm run build
```
This produces `dist/browser` and `dist/node`.

### Testing
The project uses `vitest`.
```bash
npm test
```
**Important:** Run tests after any logic change.

## Coding Conventions

1.  **Spec Compliance**: All mapping logic must strictly follow `SPECIFICATION.md`. If the spec says "Map H to H1-H6", do exactly that.
2.  **PDF.js Integration**: We interact with internal `pdf.js` classes (`Dict`, `Name`, `Ref`, etc.).
    - Be careful with types; `pdf.js` internals are not fully typed in our context, so we often inspect the source in `pdf.js/src/core/`.
    - Do not modify the `pdf.js` directory.
3.  **TypeScript**: Use strict typing. Avoid `any` where possible.
4.  **Comments**: heavily comment code with references to the specification (e.g., `// 4.2.3 ClassMap -> CSS`).
