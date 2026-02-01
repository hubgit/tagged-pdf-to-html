import { LocalPdfManager } from "#pdfjs/core/pdf_manager.js";
import { StructTreeRoot } from "#pdfjs/core/struct_tree.js";
import { Dict } from "#pdfjs/core/primitives.js";
import { ContentExtractor } from "./content_extractor.ts";
import type { XRef, PDFDocument, PDFManager, StructTreeRootType } from "./types.ts";

// Extend globalThis for PDFJSDev
declare global {
    var PDFJSDev: { test: () => boolean; eval: () => boolean } | undefined;
}

const isBrowserEnv = typeof window !== "undefined" && typeof document !== "undefined";
// Mock PDFJSDev globally for pdf.js to work (Node only).
if (!isBrowserEnv && typeof globalThis.PDFJSDev === "undefined") {
    globalThis.PDFJSDev = {
        test: () => false,
        eval: () => false,
    };
}

export interface PDFContext {
    manager: PDFManager;
    pdfDocument: PDFDocument;
    xref: XRef;
    rootDict: Dict;
    structTreeRoot: StructTreeRootType | null;
    pageContentExtractors: Map<number, ContentExtractor>;
    filename: string;
}

export async function createPDFContext(data: Uint8Array, filename: string = "document.pdf"): Promise<PDFContext> {
    const manager = new LocalPdfManager({
        source: data,
        evaluatorOptions: {
            isOffscreenCanvasSupported: false,
            isImageDecoderSupported: false,
        },
        docId: "pdf-html-conversion",
        password: "",
    });

    const pdfDocument = manager.pdfDocument;

    // Initialize document
    pdfDocument.checkHeader();
    pdfDocument.parseStartXRef();
    pdfDocument.parse();

    const xref = pdfDocument.xref;
    const rootDict = xref.root;
    if (!rootDict) {
        throw new Error("Invalid PDF: No Root dictionary found");
    }

    let structTreeRoot = null;
    const structTreeRootRef = rootDict.getRaw("StructTreeRoot");
    if (structTreeRootRef) {
        const structTreeRootObj = rootDict.get("StructTreeRoot");
        structTreeRoot = new StructTreeRoot(xref, structTreeRootObj, structTreeRootRef);
        structTreeRoot.init();
    }

    // Type assertions needed because PDF.js doesn't have official TypeScript declarations
    // and the actual types are close enough but not perfectly matching our interfaces
    return {
        manager: manager as unknown as PDFManager,
        pdfDocument: pdfDocument as unknown as PDFDocument,
        xref: xref as unknown as XRef,
        rootDict,
        structTreeRoot: structTreeRoot as StructTreeRootType | null,
        pageContentExtractors: new Map(),
        filename
    };
}
