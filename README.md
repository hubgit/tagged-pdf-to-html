# Tagged PDF to HTML

A TypeScript library (mostly vibe-coded with Codex, Gemini and Claude) that implements the "Deriving HTML from PDF" algorithm using `pdf.js`.

## Demo

```sh
serve .
open http://localhost:3000/demo/
```

## Features

- Extracts HTML structure from Tagged PDF (using the Structure Tree).
- Maps PDF Structure Types to semantic HTML5 tags.
- Generates CSS classes from PDF ClassMap.
- Extracts text content mapped to structure elements.
- Handles attributes (ID, Lang, Alt, Title).

## Usage

```typescript
import { deriveHtmlFromPdf } from "@aeaton/tagged-pdf-to-html";
import fs from "fs";

const pdfData = new Uint8Array(fs.readFileSync("document.pdf"));
const html = await deriveHtmlFromPdf(pdfData);
console.log(html);
```

## Requirements

- Node.js
- `pdf.js` source code must be available in `pdf.js` relative to this project (as currently configured in `tsconfig.json`).

## Building

```bash
npm install
npm run build
```
