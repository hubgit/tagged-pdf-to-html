import { createPDFContext } from "./pdf_js_context.ts";
import { convertToHTML } from "./converter.ts";

export interface SerializableStructTreeElement {
    role: string;
    children: SerializableStructTreeNode[];
    alt?: string;
    lang?: string;
    mathML?: string;
    bbox?: number[];
}

export interface SerializableStructTreeLeaf {
    type: "content" | "object" | "annotation";
    id: string;
}

export type SerializableStructTreeNode = SerializableStructTreeElement | SerializableStructTreeLeaf;

export interface HtmlWithStructureTree {
    html: string;
    structureTree: SerializableStructTreeElement;
}

export async function deriveHtmlFromPdf(data: Uint8Array): Promise<string> {
    const context = await createPDFContext(data);
    if (!context.structTreeRoot) {
        throw new Error("PDF is not tagged (no StructTreeRoot found).");
    }
    return convertToHTML(context);
}

export async function deriveHtmlWithStructureTree(data: Uint8Array): Promise<HtmlWithStructureTree> {
    const context = await createPDFContext(data);
    if (!context.structTreeRoot) {
        throw new Error("PDF is not tagged (no StructTreeRoot found).");
    }
    const html = await convertToHTML(context);
    const firstPage = await context.pdfDocument.getPage(0);
    const pageTree = firstPage.getStructTree ? await firstPage.getStructTree() : null;
    const fallbackTree: SerializableStructTreeElement = { role: "Root", children: [] };
    const structureTree = (pageTree ?? fallbackTree) as SerializableStructTreeElement;
    return { html, structureTree };
}
