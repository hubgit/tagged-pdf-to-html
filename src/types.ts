/**
 * Type definitions for PDF.js objects used in this codebase.
 * These provide better typing than `any` while remaining practical for PDF.js integration.
 *
 * Note: PDF.js doesn't have official TypeScript declarations, so these types
 * are approximations based on usage patterns. Type assertions may still be
 * needed in some cases.
 */

import { Dict, Ref, Name } from "#pdfjs/core/primitives.js";

// Re-export for convenience
export { Dict, Ref, Name };

/** A value that can be either a direct object or a Ref to be dereferenced */
export type PDFObjectOrRef<T = unknown> = T | Ref;

/** PDF attribute values - can be Dict, array of Dicts, or null */
export type PDFAttributes = Dict | Dict[] | null;

/** PDF color value - array of numbers (grayscale [g], RGB [r,g,b], or CMYK [c,m,y,k]) */
export type PDFColor = number[];

/** Relationship type for associated files */
export type AFRelationship = "Alternative" | "Supplement" | "Ignore";

/**
 * XRef interface - cross-reference table for PDF object lookup.
 * Methods return unknown and require type assertions at call sites.
 */
export interface XRef {
    fetchIfRef<T = unknown>(ref: unknown): T;
    fetchIfRefAsync<T = unknown>(ref: unknown): Promise<T>;
    fetch<T = unknown>(ref: Ref): T;
    root: Dict | undefined;
}

/** PDF Page interface - subset of methods used by this codebase */
export interface PDFPage {
    view: number[];
    rotate: number;
    userUnit?: number;
    resources: Promise<Dict | null>;
    pageDict?: Dict;
    extractTextContent(options: TextContentOptions): Promise<TextContentResult>;
    getOperatorList(options: OperatorListOptions): Promise<void>;
    getStructTree?(): Promise<unknown>;
}

/** Text content extraction options */
export interface TextContentOptions {
    handler: null;
    task: { name: string; ensureNotTerminated: () => void };
    includeMarkedContent: boolean;
    disableNormalization: boolean;
    sink: {
        enqueue: (chunk: { items?: TextItem[] }) => void;
        desiredSize: number;
        ready: Promise<void>;
    };
}

/** Text content result */
export interface TextContentResult {
    items?: TextItem[];
}

/** Text item from text extraction */
export interface TextItem {
    type?: string;
    id?: string;
    str?: string;
    hasEOL?: boolean;
}

/** Operator list options */
export interface OperatorListOptions {
    handler: {
        send: (name: string, data: unknown) => void;
        sendWithPromise: (name: string, data: unknown) => Promise<unknown>;
    };
    sink: {
        enqueue: (chunk: { fnArray?: number[]; argsArray?: unknown[] }) => void;
        ready: Promise<void>;
    };
    task: { ensureNotTerminated: () => void };
    intent: number;
}

/** PDF Catalog interface */
export interface PDFCatalog {
    getPageIndex(ref: Ref): Promise<number>;
}

/** PDF Document interface (internal document, not PDFDocumentProxy) */
export interface PDFDocument {
    catalog: PDFCatalog;
    xref: XRef;
    numPages?: number;
    checkHeader(): void;
    parseStartXRef(): void;
    parse(): void;
    getPage(index: number): Promise<PDFPage>;
}

/** Local PDF Manager interface */
export interface PDFManager {
    pdfDocument: PDFDocument;
}

/** Structure tree root interface */
export interface StructTreeRootType {
    dict: Dict;
    roleMap?: Map<string, string>;
    init(): void;
}

/** PDF Stream with dictionary */
export interface PDFStream {
    dict: Dict;
    getBytes(): Uint8Array;
}

/** Image XObject interface - loosely typed since structure varies */
export interface ImageXObject {
    dict?: Dict;
    get?(key: string): unknown;
    Width?: number;
    Height?: number;
}

/** PDF operator with function code and arguments */
export interface PDFOperator {
    fn: number;
    args: unknown[];
}

/** Extracted image from content */
export interface ExtractedImage {
    type: "XObject" | "Inline";
    name?: string;
    data?: ImageXObject;
    width?: number;
    height?: number;
}

/** Marked content properties */
export interface MarkedContentProps {
    Lang?: string;
    ActualText?: string;
    Alt?: string;
    E?: string;
}

/**
 * A PDF object that has been resolved from a Ref.
 * Could be a Dict, Stream with dict, number (MCID), or other primitive.
 */
export type ResolvedPDFObject = Dict | { dict: Dict } | number | string | null | undefined;

/**
 * An annotation or widget object from the PDF
 */
export interface PDFAnnotation {
    get(key: string): unknown;
    getRaw(key: string): Ref | unknown;
    getKeys?(): string[];
}
