import { PDFContext } from "./pdf_js_context.ts";
import { Dict, Name, Ref } from "#pdfjs/core/primitives.js";
import { stringToPDFString } from "#pdfjs/shared/util.js";
import type { AFRelationship, PDFStream } from "./types.ts";

// Spec 4.6.3 Table 9
const MEDIA_TYPES: Record<string, string> = {
    "text/html": "html",
    "application/xhtml+xml": "html",
    "text/css": "css",
    "text/javascript": "js",
    "application/javascript": "js",
    "image/jpeg": "image",
    "image/png": "image",
    "image/gif": "image",
    "image/svg+xml": "svg",
    "application/mathml+xml": "mathml",
    "text/xml": "mathml" // Fallback for some producers
};

export interface AFResult {
    content: string; // The HTML string to output
    relationship: "Alternative" | "Supplement" | "Ignore";
    place: "Head" | "Inline" | "After"; // Where to put it
}

export async function processHeadAssociatedFiles(context: PDFContext): Promise<string> {
    const { structTreeRoot, rootDict } = context;
    if (!structTreeRoot && !rootDict) return "";

    // §4.6.4: include document-level and structure-tree associated files in head
    const afs: (Ref | Dict)[] = [];
    if (rootDict) afs.push(...getAssociatedFiles(context, rootDict));
    if (structTreeRoot) afs.push(...getAssociatedFiles(context, structTreeRoot.dict));
    if (afs.length === 0) return "";

    const seenRefs = new Set<string>();
    const seenDicts = new WeakSet<Dict>();
    let headContent = "";

    for (const af of afs) {
        if (af instanceof Ref) {
            const key = getRefKey(af);
            if (seenRefs.has(key)) continue;
            seenRefs.add(key);
        } else if (af instanceof Dict) {
            if (seenDicts.has(af)) continue;
            seenDicts.add(af);
        }
        const result = await processAssociatedFile(context, af, true);
        if (result && result.content) {
            headContent += result.content + "\n";
        }
    }
    return headContent;
}

function getRefKey(ref: Ref): string {
    return `${ref.num}R${ref.gen}`;
}

export async function getStructureAssociatedFiles(context: PDFContext, element: Dict): Promise<{ replacement?: string, supplements: string[] }> {
    const afs = getAssociatedFiles(context, element);
    if (afs.length === 0) return { supplements: [] };

    let replacement: string | undefined;
    const supplements: string[] = [];

    for (const af of afs) {
        const result = await processAssociatedFile(context, af, false);
        if (!result) continue;

        if (result.relationship === "Alternative") {
            // First valid alternative takes precedence (usually)
            if (replacement === undefined) {
                replacement = result.content;
            }
        } else if (result.relationship === "Supplement") {
            supplements.push(result.content);
        }
    }

    return { replacement, supplements };
}

function getAssociatedFiles(context: PDFContext, dict: Dict): (Ref | Dict)[] {
    const af = dict.get("AF") as Ref | Dict | (Ref | Dict)[] | null;
    if (!af) return [];
    if (Array.isArray(af)) return af;
    return [af];
}

async function processAssociatedFile(context: PDFContext, fileSpecRef: Ref | Dict, isHead: boolean): Promise<AFResult | null> {
    const fileSpec = context.xref.fetchIfRef(fileSpecRef);
    if (!fileSpec || !(fileSpec instanceof Dict)) return null;

    // Spec 4.6.1: Check EF (Embedded File) vs FS=URL
    // We prioritize Embedded Files for robust extraction
    const ef = fileSpec.get("EF");
    const fs = fileSpec.get("FS")?.name;

    // Check Relationship
    const relationshipName = (fileSpec.get("AFRelationship") as Name | undefined)?.name || "Supplement"; // Default? Spec doesn't strictly say default, implies Ignore if not Alt/Supp.
    // 4.6.4.1: "Associated files with a value other than Alternative or Supplement... may be ignored"

    if (relationshipName !== "Alternative" && relationshipName !== "Supplement") {
         return null;
    }
    const relationship: AFRelationship = relationshipName as AFRelationship;

    // 1. Embedded File
    if (ef) {
        const embeddedRef = (ef.get("F") || ef.get("UF")) as Ref | Dict | undefined;
        if (embeddedRef) {
            return await processEmbeddedFile(context, embeddedRef, relationship, isHead);
        }
    }

    // 2. URL Reference
    if (fs === "URL") {
        const f = fileSpec.get("F") as string | undefined;
        if (f) {
            const url = stringToPDFString(f);
            return processURLReference(url, relationship, isHead);
        }
    }

    return null;
}

async function processEmbeddedFile(context: PDFContext, streamRef: Ref | Dict, relationship: AFRelationship, isHead: boolean): Promise<AFResult | null> {
    const stream = await context.xref.fetchIfRefAsync<PDFStream>(streamRef);
    if (!stream || !stream.dict) return null;

    const subtype = (stream.dict.get("Subtype") as Name | undefined)?.name;
    const typeCategory = subtype ? MEDIA_TYPES[subtype] : undefined;

    if (!typeCategory) return null;

    // Get Data
    let data: Uint8Array;
    try {
        data = stream.getBytes();
    } catch (e) {
        return null;
    }

    // Convert based on type
    if (typeCategory === "html") {
        const text = new TextDecoder().decode(data);
        // Spec 4.6.4.2: Direct injection
        // If Head: Inject directly.
        // If Inline (Supplement/Alternative): Inject directly.
        return {
            content: text,
            relationship,
            place: isHead ? "Head" : "Inline"
        };
    }

    if (typeCategory === "css") {
        const text = new TextDecoder().decode(data);
        // Spec 4.6.4.3:
        // If Embedded CSS: output HTML style element...
        return {
            content: `<style>\n${text}\n</style>`,
            relationship,
            place: isHead ? "Head" : "Inline"
        };
    }

    if (typeCategory === "js") {
        const text = new TextDecoder().decode(data);
        // Spec 4.6.4.4:
        // Script element
        return {
            content: `<script>\n${text}\n</script>`,
            relationship,
            place: isHead ? "Head" : "After" // JS usually after closing tag
        };
    }

    if (typeCategory === "mathml") {
        const text = new TextDecoder().decode(data);
        return {
            content: text,
            relationship,
            place: "Inline"
        };
    }

    if (typeCategory === "image" || typeCategory === "svg") {
        // Create Data URI
        const base64 = fromByteArray(data);
        const src = `data:${subtype};base64,${base64}`;

        // Spec 4.6.4.5 / 4.6.4.6: <img> element
        // If SVG and Supplement?
        return {
            content: `<img src="${src}" alt="Associated Image" />`,
            relationship,
            place: "Inline"
        };
    }

    return null;
}

function processURLReference(url: string, relationship: AFRelationship, isHead: boolean): AFResult | null {
    // Determine type from extension if possible?
    // Spec 4.6.3: Use filename extension.
    const ext = url.split('.').pop()?.toLowerCase();

    let tag = "";

    // Simple heuristic based on extension
    if (ext === "css") {
         // Spec 4.6.4.3: @import
         tag = `<style>@import url(${url});</style>`;
    } else if (ext === "js") {
         // Spec 4.6.4.4
         tag = `<script src="${url}"></script>`;
    } else if (['jpg', 'jpeg', 'png', 'gif', 'svg'].includes(ext || "")) {
         tag = `<img src="${url}" />`;
    } else if (['html', 'htm'].includes(ext || "")) {
         // Spec 4.6.4.2 URL Ref: <link rel="import" href="..."> -> Spec says link element with rel=import (Wait, HTML Imports are deprecated/removed in modern browsers).
         // Spec 4.6.4.2: "processor shall add a link element... with attributes of rel (with a value of import) and href..."
         // We follow spec even if deprecated in browsers.
         tag = `<link rel="import" href="${url}" />`;
    } else {
        return null;
    }

    return {
        content: tag,
        relationship,
        place: isHead ? "Head" : "Inline"
    };
}

// Polyfill for Buffer/btoa in typical JS env if needed, or use Buffer if Node
function fromByteArray(bytes: Uint8Array): string {
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes).toString('base64');
    }
    // Browser fallback
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
