import { PDFContext } from "./pdf_js_context.ts";
import { Dict, Name, Ref } from "#pdfjs/core/primitives.js";
import { ContentExtractor } from "./content_extractor.ts";
import { ImageKind, stringToPDFString } from "#pdfjs/shared/util.js";
import { convertToRGBA } from "#pdfjs/shared/image_utils.js";
import { getHTMLAttributes, getCSSProperties, getBBox } from "./attribute_mapper.ts";
import { getStructureAssociatedFiles } from "./associated_files.ts";
import { convertImageXObject } from "./image_converter.ts";
import { generateSVG } from "./svg_generator.ts";
import { createCanvas } from "#platform/canvas";
import { PageViewport } from "#pdfjs/display/display_utils.js";
import type { PDFAttributes, PDFOperator, PDFPage } from "./types.ts";

interface TraversalContext {
    parentRole?: string;
    listNumbering?: string;
    listHasLbl?: boolean;
    bbox?: number[];
    headingLevel?: number;
    imageAlt?: string;
    preferVector?: boolean;
    mathmlTokenContext?: boolean;
    idState: IdState;
}

interface IdState {
    byRef: Map<string, string>;
    byDict: WeakMap<Dict, string>;
    counter: number;
}

interface RenderedContent {
    html: string;
    text: string;
    rootTag: string | null;
}

/** Structure element child - can be MCID (number), Ref, or Dict */
type StructChild = number | Ref | Dict;

/** Resolved structure element - could be Dict directly or object with dict property */
type ResolvedStructElement = Dict | { dict: Dict } | number | null | undefined;

/** Helper to get Dict from a resolved PDF object */
function getDict(obj: ResolvedStructElement): Dict | null {
    if (!obj || typeof obj === 'number') return null;
    if (obj instanceof Dict) return obj;
    if ('dict' in obj && obj.dict instanceof Dict) return obj.dict;
    return null;
}

function getNamespaceURI(context: PDFContext, dict: Dict): string {
    const namespaceObj = dict.get("NS");
    if (!namespaceObj) return "";
    const nsDict = context.xref.fetchIfRef<Dict>(namespaceObj);
    if (!nsDict || !(nsDict instanceof Dict)) return "";
    const nsValue = nsDict.get("NS") as string | undefined;
    return nsValue ? stringToPDFString(nsValue) : "";
}

function getRefKey(ref: Ref): string {
    return `${ref.num}R${ref.gen}`;
}

function lookupGeneratedId(childOrRef: StructChild, dict: Dict, idState: IdState): string | null {
    if (childOrRef instanceof Ref) {
        const key = getRefKey(childOrRef);
        return idState.byRef.get(key) || null;
    }
    return idState.byDict.get(dict) || null;
}

function ensureGeneratedId(childOrRef: StructChild, dict: Dict, idState: IdState): string {
    const existing = lookupGeneratedId(childOrRef, dict, idState);
    if (existing) return existing;

    let generated = "";
    if (childOrRef instanceof Ref) {
        const key = getRefKey(childOrRef);
        generated = `pdf-se-${childOrRef.num}-${childOrRef.gen}`;
        idState.byRef.set(key, generated);
        return generated;
    }

    generated = `pdf-se-${idState.counter}`;
    idState.counter += 1;
    idState.byDict.set(dict, generated);
    return generated;
}

// Helper to escape HTML
function escapeHtml(unsafe: unknown): string {
     if (typeof unsafe !== 'string') return "";
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}


export async function traverseStructure(context: PDFContext): Promise<string> {
    const { structTreeRoot } = context;
    if (!structTreeRoot) return "";

    const children = structTreeRoot.dict.get("K");
    // Start with heading level 1 (or 0 if we want the first section to be h1)
    // Typically document root might not be a section.
    const idState: IdState = { byRef: new Map(), byDict: new WeakMap(), counter: 1 };
    const rendered = await processChildren(context, children, null, { headingLevel: 1, idState });
    return rendered.html;
}

async function processChildren(
    context: PDFContext,
    children: StructChild | StructChild[] | null,
    inheritedPageRef: Ref | null,
    traversalCtx: TraversalContext
): Promise<RenderedContent> {
    if (!children) return { html: "", text: "", rootTag: null };

    let html = "";
    let text = "";
    let lastChildHadActualText = false;
    if (Array.isArray(children)) {
        // Special handling for Caption elements - they must be first child (§6.3.3)
        // Reorder: Caption elements move to beginning
        const reordered = await reorderCaptionElements(context, children);

        for (const child of reordered) {
            // §6.5: Nested list handling - wrap nested lists in LI
            const childInfo = getElementInfo(context, child);
            const childRendered = await processStructElement(context, child, inheritedPageRef, traversalCtx);
            const childRole = childInfo.role;

            // Check if we need to wrap nested list (parent is L, child is also L without LI wrapper)
            if (traversalCtx.parentRole === "L") {
                if (childRole === "L") {
                    // Nested list without intermediate LI - add wrapper
                    html += `<li>${childRendered.html}</li>`;
                    text += childRendered.text;
                } else {
                    html += childRendered.html;
                    text += childRendered.text;
                }
            } else {
                if (shouldInsertInlineSpace(
                    traversalCtx.parentRole,
                    childRole,
                    text,
                    childRendered.text,
                    lastChildHadActualText,
                    childInfo.hasActualText,
                    childRendered.rootTag
                )) {
                    html += " ";
                    text += " ";
                }
                html += childRendered.html;
                text += childRendered.text;
            }

            lastChildHadActualText = childInfo.hasActualText;
        }
    } else {
        const childRendered = await processStructElement(context, children, inheritedPageRef, traversalCtx);
        html += childRendered.html;
        text += childRendered.text;
    }
    return { html, text, rootTag: null };
}

function shouldInsertInlineSpace(
    parentRole: string | undefined,
    childRole: string | null,
    prevText: string,
    nextText: string,
    prevHadActualText: boolean,
    nextHasActualText: boolean,
    nextRootTag: string | null
): boolean {
    if (!isInlineContext(parentRole)) return false;
    if (!prevText || !nextText) return false;
    if (childRole === "Sup" || childRole === "Sub") return false;
    if (nextRootTag === "sup" || nextRootTag === "sub") return false;
    if (!hasVisibleText(prevText) || !hasVisibleText(nextText)) return false;
    if (hasTrailingWhitespace(prevText) || hasLeadingWhitespace(nextText)) return false;

    const prevChar = getLastVisibleChar(prevText);
    const nextChar = getFirstVisibleChar(nextText);
    if (!prevChar || !nextChar) return false;

    const shouldConsider = prevHadActualText || nextHasActualText || /[:;.!?]/.test(prevChar);
    if (!shouldConsider) return false;

    if (/[([{\"'\/-]/.test(prevChar)) return false;
    if (/[\])}.,;:!?%]/.test(nextChar)) return false;
    if (!isWordChar(nextChar)) return false;

    return true;
}

function getFirstVisibleChar(text: string): string | null {
    const match = text.match(/[^\s]/);
    return match ? match[0] : null;
}

function getLastVisibleChar(text: string): string | null {
    for (let i = text.length - 1; i >= 0; i -= 1) {
        const ch = text[i];
        if (!/\s/.test(ch)) return ch;
    }
    return null;
}

function hasVisibleText(text: string): boolean {
    return /\S/.test(text);
}

function hasLeadingWhitespace(text: string): boolean {
    return /^\s/.test(text);
}

function hasTrailingWhitespace(text: string): boolean {
    return /\s$/.test(text);
}

function splitEdgeWhitespace(text: string): { leading: string; core: string; trailing: string } {
    let start = 0;
    while (start < text.length && /\s/.test(text[start])) start += 1;
    let end = text.length;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    return {
        leading: text.slice(0, start),
        core: text.slice(start, end),
        trailing: text.slice(end)
    };
}

function extractTextFromHtml(html: string): string {
    if (!html) return "";
    let out = "";
    let i = 0;
    while (i < html.length) {
        const ch = html[i];
        if (ch === "<") {
            if (html.startsWith("<!--", i)) {
                const end = html.indexOf("-->", i + 4);
                if (end === -1) break;
                i = end + 3;
                continue;
            }
            const tagEnd = html.indexOf(">", i + 1);
            if (tagEnd === -1) break;
            const tagText = html.slice(i + 1, tagEnd).trim().toLowerCase();
            if (tagText.startsWith("script") || tagText.startsWith("style")) {
                const closeTag = `</${tagText.split(/\s+/)[0]}>`;
                const closeIndex = html.toLowerCase().indexOf(closeTag, tagEnd + 1);
                if (closeIndex === -1) break;
                i = closeIndex + closeTag.length;
                continue;
            }
            i = tagEnd + 1;
            continue;
        }
        out += ch;
        i += 1;
    }
    return decodeHtmlEntities(out);
}

function decodeHtmlEntities(text: string): string {
    const named: Record<string, string> = {
        nbsp: " ",
        amp: "&",
        lt: "<",
        gt: ">",
        quot: "\"",
        apos: "'"
    };
    return text.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (match, body) => {
        if (body[0] === "#") {
            const isHex = body[1] === "x" || body[1] === "X";
            const num = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
            if (Number.isFinite(num) && num >= 0 && num <= 0x10ffff) {
                return String.fromCodePoint(num);
            }
            return match;
        }
        const key = String(body).toLowerCase();
        return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : match;
    });
}

function isWordChar(ch: string): boolean {
    return /[A-Za-z0-9]/.test(ch);
}

async function reorderCaptionElements(context: PDFContext, children: StructChild[]): Promise<StructChild[]> {
    const captions: StructChild[] = [];
    const others: StructChild[] = [];

    for (const childOrRef of children) {
        const child = context.xref.fetchIfRef<ResolvedStructElement>(childOrRef);
        if (!child || typeof child === 'number') {
            others.push(childOrRef);
            continue;
        }

        const dict = getDict(child);
        if (!dict) {
            others.push(childOrRef);
            continue;
        }
        const sType = (dict.get("S") as Name | undefined)?.name;

        if (!sType) {
            others.push(childOrRef);
            continue;
        }

        // Resolve through RoleMap if needed
        const roleMap = context.structTreeRoot?.roleMap;
        const namespaceURI = getNamespaceURI(context, dict);
        const mappedRole = resolveRole(sType, roleMap, namespaceURI);

        if (mappedRole === "Caption") {
            captions.push(childOrRef);
        } else {
            others.push(childOrRef);
        }
    }

    // Captions first, then everything else
    return [...captions, ...others];
}

// §6.5: Helper to get element's role without full processing
async function getElementRole(context: PDFContext, childOrRef: StructChild): Promise<string | null> {
    const child = context.xref.fetchIfRef<ResolvedStructElement>(childOrRef);

    if (!child || typeof child === 'number') {
        return null;
    }

    const dict = getDict(child);
    if (!dict) return null;
    const sType = (dict.get("S") as Name | undefined)?.name;

    if (!sType) {
        return null;
    }

    // Resolve through RoleMap
    const roleMap = context.structTreeRoot?.roleMap;
    const namespaceURI = getNamespaceURI(context, dict);
    return resolveRole(sType, roleMap, namespaceURI);
}

function getElementInfo(context: PDFContext, childOrRef: StructChild): { role: string | null; hasActualText: boolean } {
    const child = context.xref.fetchIfRef<ResolvedStructElement>(childOrRef);
    if (!child || typeof child === 'number') {
        return { role: null, hasActualText: false };
    }

    const dict = getDict(child);
    if (!dict) return { role: null, hasActualText: false };

    const sType = (dict.get("S") as Name | undefined)?.name;
    if (!sType) return { role: null, hasActualText: false };

    const roleMap = context.structTreeRoot?.roleMap;
    const namespaceURI = getNamespaceURI(context, dict);
    return {
        role: resolveRole(sType, roleMap, namespaceURI),
        hasActualText: dict.has("ActualText")
    };
}

// §6.3: Check if list contains Lbl elements
async function hasLblChildren(
    context: PDFContext,
    listElement: Dict,
    listItemRole: "LI" | "TOCI" = "LI"
): Promise<boolean> {
    const k = listElement.get("K") as StructChild | StructChild[] | null;
    let children: StructChild[] = [];
    if (Array.isArray(k)) children = k;
    else if (k !== null && k !== undefined) children = [k];

    const roleMap = context.structTreeRoot?.roleMap;
    const seen = new WeakSet<Dict>();

    const hasLblDescendant = async (element: Dict): Promise<boolean> => {
        if (seen.has(element)) return false;
        seen.add(element);

        const elementType = (element.get("S") as Name | undefined)?.name;
        if (elementType) {
            const namespaceURI = getNamespaceURI(context, element);
            const mapped = resolveRole(elementType, roleMap, namespaceURI);
            if (mapped === "Lbl") {
                return true;
            }
        }

        const elementKids = element.get("K") as StructChild | StructChild[] | null;
        if (!elementKids) return false;
        const elementChildren = Array.isArray(elementKids) ? elementKids : [elementKids];

        for (const childOrRef of elementChildren) {
            const child = context.xref.fetchIfRef<ResolvedStructElement>(childOrRef);
            if (!child || typeof child === "number") continue;
            const childDict = getDict(child);
            if (!childDict) continue;
            if (await hasLblDescendant(childDict)) return true;
        }
        return false;
    };

    for (const childOrRef of children) {
        const child = context.xref.fetchIfRef<ResolvedStructElement>(childOrRef);
        if (!child || typeof child === 'number') continue;

        // Check if this is LI
        const dict = getDict(child);
        if (!dict) continue;
        const sType = (dict.get("S") as Name | undefined)?.name;
        if (!sType) continue;

        const namespaceURI = getNamespaceURI(context, dict);
        const mappedRole = resolveRole(sType, roleMap, namespaceURI);

        if (mappedRole === listItemRole) {
            if (await hasLblDescendant(dict)) {
                return true;
            }
        }
    }

    return false;
}

async function hasLinkChild(context: PDFContext, element: Dict): Promise<boolean> {
    const roleMap = context.structTreeRoot?.roleMap;
    const k = element.get("K") as StructChild | StructChild[] | null;
    if (!k) return false;
    const children = Array.isArray(k) ? k : [k];

    for (const childOrRef of children) {
        const child = context.xref.fetchIfRef<ResolvedStructElement>(childOrRef);
        if (!child || typeof child === "number") continue;
        const dict = getDict(child);
        if (!dict) continue;
        const sType = (dict.get("S") as Name | undefined)?.name;
        if (!sType) continue;
        const namespaceURI = getNamespaceURI(context, dict);
        const mappedRole = resolveRole(sType, roleMap, namespaceURI);
        if (mappedRole === "Link") return true;
    }
    return false;
}

async function processStructElement(
    context: PDFContext,
    childOrRef: StructChild,
    inheritedPageRef: Ref | null,
    traversalCtx: TraversalContext
): Promise<RenderedContent> {
    const { xref, structTreeRoot } = context;
    let child = xref.fetchIfRef<ResolvedStructElement>(childOrRef);

    if (child === null || child === undefined) return { html: "", text: "", rootTag: null };

    // Handle Number (MCID)
    if (typeof child === 'number') {
        if (inheritedPageRef) {
             return processMCID(
                 context,
                 child,
                 inheritedPageRef,
                 traversalCtx.bbox,
                 traversalCtx.imageAlt,
                 traversalCtx.preferVector,
                 traversalCtx.mathmlTokenContext
             );
        }
        return { html: `<!-- MCID ${child} (No Page) -->`, text: "", rootTag: null };
    }

    // Handle Dict or Stream - get the Dict
    const childDict = getDict(child);
    if (!childDict) {
        return { html: "", text: "", rootTag: null };
    }

    // Update inheritedPageRef
    const pg = childDict.getRaw("Pg") as Ref | null;
    if (pg) {
        inheritedPageRef = pg;
    }

    // Check type
    const type = (childDict.get("Type") as Name | undefined)?.name;
    const sType = (childDict.get("S") as Name | undefined)?.name; // Structure Type

    if (type === "MCR") {
        return processMCR(
            context,
            childDict,
            inheritedPageRef,
            traversalCtx.bbox,
            traversalCtx.imageAlt,
            traversalCtx.preferVector,
            traversalCtx.mathmlTokenContext
        );
    }

    if (type === "OBJR") {
        return processOBJR(context, childDict, inheritedPageRef);
    }

    // Process Associated Files (AF) - Spec 4.6
    const afResult = await getStructureAssociatedFiles(context, childDict);

    // If we have a replacement (Alternative), we use it and ignore children/standard processing
    if (afResult.replacement !== undefined) {
        let out = afResult.replacement;
        if (afResult.supplements.length > 0) {
            out += afResult.supplements.join("\n");
        }
        return { html: out, text: extractTextFromHtml(afResult.replacement), rootTag: null };
    }

    // Get Attributes and BBox
    const attributes = childDict.get("A") as PDFAttributes;
    const classes = childDict.get("C");
    const bbox = getBBox(attributes);
    // Update Context with new BBox (or keep old if null? Usually structure hierarchy defines scope)
    // If this element has BBox, it overrides parent.
    // Also copy heading level
    const newTraversalCtx: TraversalContext = {
        ...traversalCtx,
        bbox: bbox || traversalCtx.bbox
    };

    if (!sType) {
         const children = childDict.get("K") as StructChild | StructChild[] | null;
         let content = "";
         let contentText = "";
         if (children) {
             const rendered = await processChildren(context, children, inheritedPageRef, newTraversalCtx);
             content = rendered.html;
             contentText = rendered.text;
         }
         // Append supplements
         if (afResult.supplements.length > 0) {
             content += afResult.supplements.join("\n");
         }
         return { html: content, text: contentText, rootTag: null };
    }

    // Namespace Check (Spec 4.3.2.3)
    const namespaceURI = getNamespaceURI(context, childDict);

    let tag = "";
    let mappedRole = "";
    let listStart: number | null = null;
    let listType: "a" | "A" | "i" | "I" | null = null;
    let headingAriaLevel: number | null = null;

    // Role Mapping
    const roleMap = structTreeRoot?.roleMap; // Map<string, string>

    const isMathML = namespaceURI === "http://www.w3.org/1998/Math/MathML";
    const isHtmlNamespace = namespaceURI === "http://www.w3.org/1999/xhtml";

    // MathML Namespace
    if (isMathML) {
        // Use sType directly as tag
        tag = sType;
        mappedRole = sType;
    } else if (isHtmlNamespace) {
        tag = sType.toLowerCase();
        mappedRole = sType;
    } else {
        // Standard Role Mapping
        mappedRole = resolveRole(sType, roleMap, namespaceURI);

        // Base Tag mapping
        tag = mapRoleToTag(mappedRole, traversalCtx.parentRole);

        // Update Heading Level for children if we are entering a grouping element
        if (mappedRole === "Sect" || mappedRole === "Div" || mappedRole === "Art" || mappedRole === "Aside" || mappedRole === "Part" || mappedRole === "DocumentFragment") {
            newTraversalCtx.headingLevel = (traversalCtx.headingLevel || 1) + 1;
        }

        const isExplicitHeading = /^H\\d+$/.test(mappedRole);
        const isGenericHeading = mappedRole === "H" || mappedRole === "Hn" || mappedRole === "Title";
        if (isExplicitHeading || isGenericHeading) {
            // §6.6: Headings inside table cells must be remapped to P
            if (traversalCtx.parentRole === "TH" || traversalCtx.parentRole === "TD") {
                tag = "p";
            } else {
                let level = traversalCtx.headingLevel || 2;
                if (mappedRole === "Title") {
                    level = 1;
                } else if (isExplicitHeading) {
                    level = parseInt(mappedRole.slice(1), 10);
                }

                if (Number.isNaN(level) || level <= 0) {
                    level = traversalCtx.headingLevel || 2;
                }

                if (level <= 6) {
                    tag = `h${level}`;
                } else {
                    tag = "p";
                    headingAriaLevel = level;
                }
            }
        }

        // List Handling Context
        if (mappedRole === "L") {
            const listNumbering = getListNumbering(attributes, classes, structTreeRoot) || "None";
            const listHasLbl = await hasLblChildren(context, childDict, "LI");
            if (listNumbering === "Description") {
                tag = "dl";
            } else if (listNumbering !== "None") {
                tag = "ol";
            } else {
                tag = "ul";
            }
            newTraversalCtx.parentRole = "L";
            newTraversalCtx.listNumbering = listNumbering;
            newTraversalCtx.listHasLbl = listHasLbl;

            // §6.3: Use first label to set ordered list start when labels are explicit
            if (listHasLbl && listNumbering !== "None" && listNumbering !== "Description") {
                const labelText = await getFirstListLabelText(context, childDict, inheritedPageRef);
                listStart = parseListStart(labelText);
                listType = parseListType(labelText);
            }
        } else if (mappedRole === "TOC") {
            const tocHasLbl = await hasLblChildren(context, childDict, "TOCI");
            newTraversalCtx.parentRole = "TOC";
            newTraversalCtx.listHasLbl = tocHasLbl;
        } else if (mappedRole === "LI") {
            if (newTraversalCtx.listNumbering === "Description") {
                 tag = "div";
            } else {
                 tag = "li";
            }
            newTraversalCtx.parentRole = "LI";
        } else if (mappedRole === "Lbl") {
            if (newTraversalCtx.parentRole === "LI") {
                if (newTraversalCtx.listNumbering === "Description") {
                    tag = "dt";
                } else {
                    tag = "span";
                }
            } else if (newTraversalCtx.parentRole === "Form") {
                 tag = "label";
            } else {
                 tag = "span";
            }
        } else if (mappedRole === "LBody") {
            if (newTraversalCtx.parentRole === "LI") {
                if (newTraversalCtx.listNumbering === "Description") {
                    tag = "dd";
                } else {
                    tag = "div";
                }
            } else {
                tag = "div";
            }
        } else {
            // Pass down generic parent role
            newTraversalCtx.parentRole = mappedRole;
        }

        // §8.5.1: TextPosition overrides tag to sup/sub when present
        const textPosition = getAttribute(attributes, "TextPosition");
        const textPositionName =
            textPosition instanceof Name
                ? textPosition.name
                : (textPosition as any)?.name;
        if (textPositionName === "Sup") {
            if (mappedRole !== "Sup") tag = "sup";
        } else if (textPositionName === "Sub") {
            if (mappedRole !== "Sub") tag = "sub";
        }
    }

    // §12.5.6 MathML: avoid edge whitespace in token elements.
    newTraversalCtx.mathmlTokenContext = isMathML ? isMathMLTokenElement(tag) : false;

    if (mappedRole === "Reference") {
        const hasLink = await hasLinkChild(context, childDict);
        if (hasLink) {
            const children = childDict.get("K") as StructChild | StructChild[] | null;
            if (!children) return { html: "", text: "", rootTag: null };
            return await processChildren(context, children, inheritedPageRef, {
                ...newTraversalCtx,
                parentRole: traversalCtx.parentRole
            });
        }
    }

    // Special Case: Link
    if (mappedRole === "Link") {
        return await processLink(context, childOrRef, childDict, attributes, classes, inheritedPageRef, newTraversalCtx);
    }

    // HTML Attributes
    let attrs = getHTMLAttributes(attributes);

    // Spec 4.3.2.2: data-pdf-se-type and data-pdf-se-type-original
    // "A data-pdf-se-type attribute with value of the PDF standard structure type's key name shall be added to the HTML element."
    // This implies the mapped role (standard type).
    if (mappedRole) {
        attrs += ` data-pdf-se-type="${escapeHtml(mappedRole)}"`;
    }

    // "The processor shall add a data-pdf-se-type-original attribute with a value representing the original PDF structure element type before role mapping..."
    // Only include when it differs from the mapped role to avoid redundant attributes.
    if (sType && sType !== mappedRole) {
        attrs += ` data-pdf-se-type-original="${escapeHtml(sType)}"`;
    }

    // Dynamic Heading attributes
    if (headingAriaLevel !== null) {
        attrs += ` role="heading" aria-level="${headingAriaLevel}"`;
    }

    // Standard Attributes
    const id = childDict.get("ID") as string | undefined;
    const lang = childDict.get("Lang") as string | undefined;
    const actualText = childDict.get("ActualText") as string | undefined;
    const alt = childDict.get("Alt") as string | undefined;
    const expansionText = childDict.get("E") as string | undefined;
    const title = childDict.get("T") as string | undefined;

    if (id) {
        attrs += ` id="${escapeHtml(stringToPDFString(id))}"`;
    } else {
        const generatedId = ensureGeneratedId(childOrRef, childDict, traversalCtx.idState);
        attrs += ` id="${escapeHtml(generatedId)}"`;
    }
    if (lang) attrs += ` lang="${escapeHtml(stringToPDFString(lang))}"`;

    let altStr = "";
    if (alt) {
        altStr = stringToPDFString(alt);
        attrs += ` alt="${escapeHtml(altStr)}"`;
    }

    if (title) {
        attrs += ` title="${escapeHtml(stringToPDFString(title))}"`;
    }

    const pronunciationHint = getPronunciationHint(attributes);
    if (pronunciationHint) {
        attrs += ` data-pdf-pronunciation="${escapeHtml(pronunciationHint)}"`;
    }

    // §6.5: Handle list continuation (ContinuedFrom attribute)
    if (mappedRole === "L" && tag === "ol") {
        const continuedFrom = getAttribute(attributes, "ContinuedFrom");
        if (continuedFrom) {
            // Note: Full implementation would track list IDs and item counts
            // This adds data attribute for potential JavaScript handling
            attrs += ` data-continued-from="${escapeHtml(String(continuedFrom))}"`;
        }
    }
    if (mappedRole === "L" && tag === "ol" && listStart && listStart > 1) {
        attrs += ` start="${listStart}"`;
    }
    if (mappedRole === "L" && tag === "ol" && listType) {
        attrs += ` type="${listType}"`;
    }

    // Classes
    if (classes) {
        const classStr = extractClassNames(classes).join(" ");
        if (classStr) attrs += ` class="${escapeHtml(classStr)}"`;
    }

    // CSS Properties (Inline Style)
    let style = getCSSProperties(attributes);

    // §6.3: If list contains Lbl elements, suppress default markers
    if ((mappedRole === "L" || mappedRole === "TOC") && newTraversalCtx.listHasLbl) {
        style = style ? style + " list-style-type: none;" : "list-style-type: none";
    }

    // §6.3: Inline list bodies when labels are explicitly provided
    if (mappedRole === "LBody" && traversalCtx.listHasLbl && traversalCtx.listNumbering !== "Description") {
        style = style ? style + " display: inline-block; vertical-align: top;" : "display:inline-block; vertical-align: top;";
    }

    // §6.3: Add spacing/alignment for list labels when labels are explicit
    if (mappedRole === "Lbl" && traversalCtx.parentRole === "LI" && traversalCtx.listNumbering !== "Description") {
        style = style
            ? style + " display: inline-block; vertical-align: top; margin-right: 0.4em;"
            : "display:inline-block; vertical-align: top; margin-right: 0.4em;";
    }

    if (style) attrs += ` style="${escapeHtml(style)}"`;

    if (mappedRole === "Figure" || mappedRole === "Formula") {
        newTraversalCtx.preferVector = true;
    }
    if ((mappedRole === "Figure" || mappedRole === "Formula") && altStr) {
        newTraversalCtx.imageAlt = altStr;
    }

    // Process Content/Children
    let content = "";
    let contentText = "";
    if (actualText) {
        contentText = stringToPDFString(actualText);
        content = escapeHtml(contentText);
    } else {
        const children = childDict.get("K") as StructChild | StructChild[] | null;
        const rendered = await processChildren(context, children, inheritedPageRef, newTraversalCtx);
        content = rendered.html;
        contentText = rendered.text;
    }

    // Expansion Text (E) -> <abbr>
    if (expansionText) {
        const eVal = escapeHtml(stringToPDFString(expansionText));
        content = `<abbr title="${eVal}">${content}</abbr>`;
    }

    // §4.6.4: Append supplemental associated files when present.
    if (afResult.supplements.length > 0) {
        content += afResult.supplements.join("\n");
    }

    // Output
    if (mappedRole === "NonStruct") {
        return { html: content, text: contentText, rootTag: null };
    }
    if (mappedRole === "Private" || mappedRole === "Artifact") {
        return { html: "", text: "", rootTag: null };
    }

    if (tag === "img" || tag === "br" || tag === "hr" || tag === "input") {
        return { html: `<${tag}${attrs}/>`, text: "", rootTag: tag };
    }

    return { html: `<${tag}${attrs}>${content}</${tag}>`, text: contentText, rootTag: tag };
}

// ... existing helpers ...
function getAttribute(attributes: PDFAttributes, name: string): unknown {
    if (!attributes) return null;
    if (attributes instanceof Dict) {
        if (attributes.get(name)) return attributes.get(name);
    }
    if (Array.isArray(attributes)) {
        for (const attr of attributes) {
            if (attr instanceof Dict && attr.get(name)) return attr.get(name);
        }
    }
    return null;
}

// §7.5: Pronunciation hints (PDF 2.0)
function getPronunciationHint(attributes: PDFAttributes): string | null {
    if (!attributes) return null;
    const phoneme = getAttribute(attributes, "Phoneme");
    if (phoneme) return stringToPDFString(phoneme);
    const pronunciation = getAttribute(attributes, "Pronunciation");
    if (pronunciation) return stringToPDFString(pronunciation);
    return null;
}

function extractClassNames(classes: unknown): string[] {
    const out: string[] = [];
    const pushName = (value: unknown) => {
        if (value instanceof Name) {
            out.push(value.name);
            return;
        }
        if (value && typeof (value as { name?: unknown }).name === "string") {
            out.push(String((value as { name: string }).name));
            return;
        }
        if (typeof value === "string") {
            out.push(value);
            return;
        }
        if (value !== null && value !== undefined) {
            out.push(stringToPDFString(value));
        }
    };

    if (Array.isArray(classes)) {
        for (const value of classes) pushName(value);
    } else if (classes !== null && classes !== undefined) {
        pushName(classes);
    }

    return out.filter(Boolean);
}

function getListNumbering(
    attributes: PDFAttributes,
    classes: unknown,
    structTreeRoot: PDFContext["structTreeRoot"]
): string | null {
    const direct = getAttribute(attributes, "ListNumbering") as Name | undefined;
    if (direct?.name) return direct.name;

    // §4.2: ClassMap attributes can provide list semantics (ListNumbering)
    const classNames = extractClassNames(classes);
    if (classNames.length === 0) return null;

    const classMap = structTreeRoot?.dict.get("ClassMap");
    if (!classMap || !(classMap instanceof Dict)) return null;

    for (const className of classNames) {
        const classEntry = classMap.get(className);
        const classDicts = Array.isArray(classEntry) ? classEntry : [classEntry];
        for (const classDict of classDicts) {
            if (!(classDict instanceof Dict)) continue;
            const owner = classDict.get("O")?.name;
            if (owner !== "List") continue;
            const listNumbering = (classDict.get("ListNumbering") as Name | undefined)?.name;
            if (listNumbering) return listNumbering;
        }
    }

    return null;
}

async function fetchTextForMCID(context: PDFContext, mcid: number, pgRef: Ref | null): Promise<string> {
    if (!Number.isInteger(mcid) || !pgRef) return "";
    const pageIndex = await context.pdfDocument.catalog.getPageIndex(pgRef);
    if (pageIndex === -1) return "";

    let extractor = context.pageContentExtractors.get(pageIndex);
    if (!extractor) {
        extractor = new ContentExtractor(pageIndex);
        const page = await context.pdfDocument.getPage(pageIndex);
        await extractor.extract(page);
        context.pageContentExtractors.set(pageIndex, extractor);
    }

    return extractor.getText(mcid as number);
}

async function getPlainTextForStructElement(
    context: PDFContext,
    elementDict: Dict,
    inheritedPageRef: Ref | null
): Promise<string> {
    const actualText = elementDict.get("ActualText") as string | undefined;
    if (actualText) return stringToPDFString(actualText);

    const k = elementDict.get("K") as StructChild | StructChild[] | null;
    if (!k) return "";
    const children = Array.isArray(k) ? k : [k];

    let out = "";
    for (const childOrRef of children) {
        const child = context.xref.fetchIfRef<ResolvedStructElement>(childOrRef);
        if (!child) continue;

        if (typeof child === "number") {
            out += await fetchTextForMCID(context, child, inheritedPageRef);
            continue;
        }

        const childDict = getDict(child);
        if (!childDict) continue;

        const childPgRef = (childDict.getRaw("Pg") || inheritedPageRef) as Ref | null;
        const childType = (childDict.get("Type") as Name | undefined)?.name;
        if (childType === "MCR") {
            const mcid = childDict.get("MCID") as number | undefined;
            if (Number.isInteger(mcid)) {
                out += await fetchTextForMCID(context, mcid as number, childPgRef);
            }
            continue;
        }
        if (childType === "OBJR") {
            continue;
        }

        out += await getPlainTextForStructElement(context, childDict, childPgRef);
    }

    return out;
}

async function getFirstListLabelText(
    context: PDFContext,
    listElement: Dict,
    inheritedPageRef: Ref | null
): Promise<string | null> {
    const roleMap = context.structTreeRoot?.roleMap;
    const k = listElement.get("K") as StructChild | StructChild[] | null;
    if (!k) return null;
    const children = Array.isArray(k) ? k : [k];

    for (const childOrRef of children) {
        const child = context.xref.fetchIfRef<ResolvedStructElement>(childOrRef);
        if (!child || typeof child === "number") continue;

        const dict = getDict(child);
        if (!dict) continue;
        const sType = (dict.get("S") as Name | undefined)?.name;
        if (!sType) continue;
        const namespaceURI = getNamespaceURI(context, dict);
        const mappedRole = resolveRole(sType, roleMap, namespaceURI);
        if (mappedRole !== "LI") continue;

        const liChildren = dict.get("K") as StructChild | StructChild[] | null;
        const liKids = Array.isArray(liChildren) ? liChildren : liChildren ? [liChildren] : [];
        for (const liChildOrRef of liKids) {
            const liChild = context.xref.fetchIfRef<ResolvedStructElement>(liChildOrRef);
            if (!liChild || typeof liChild === "number") continue;
            const liChildDict = getDict(liChild);
            if (!liChildDict) continue;
            const liChildType = (liChildDict.get("S") as Name | undefined)?.name;
            if (!liChildType) continue;
            const liNamespaceURI = getNamespaceURI(context, liChildDict);
            const liChildRole = resolveRole(liChildType, roleMap, liNamespaceURI);
            if (liChildRole !== "Lbl") continue;

            const lblPgRef = (liChildDict.getRaw("Pg") || inheritedPageRef) as Ref | null;
            const text = await getPlainTextForStructElement(context, liChildDict, lblPgRef);
            const trimmed = text.replace(/\s+/g, " ").trim();
            return trimmed || null;
        }
    }

    return null;
}

function parseListStart(labelText: string | null): number | null {
    if (!labelText) return null;
    const match = labelText.match(/\d+/);
    if (!match) return null;
    const value = parseInt(match[0], 10);
    return Number.isFinite(value) ? value : null;
}

function parseListType(labelText: string | null): "a" | "A" | "i" | "I" | null {
    if (!labelText) return null;
    const match = labelText.match(/[A-Za-z]+/);
    if (!match) return null;

    const letters = match[0];
    if (!letters) return null;

    const isUpper = letters === letters.toUpperCase();
    const isLower = letters === letters.toLowerCase();
    const isRoman = /^[ivxlcdm]+$/i.test(letters);

    if (isRoman) {
        return isUpper ? "I" : "i";
    }
    if (/^[a-z]+$/i.test(letters)) {
        return isUpper ? "A" : "a";
    }
    return null;
}

async function getInheritableFieldValue(context: PDFContext, obj: Dict, key: string): Promise<unknown> {
    let current: Dict | null = obj;
    const seen = new Set<Dict>();

    while (current) {
        const value = current.get(key);
        if (value !== undefined) return value;

        const parentRef = current.get("Parent");
        if (!parentRef) break;

        const parent = await context.xref.fetchIfRefAsync(parentRef);
        if (!(parent instanceof Dict)) break;
        if (seen.has(parent)) break;
        seen.add(parent);
        current = parent;
    }

    return undefined;
}

function isHeadingRoleName(role?: string): boolean {
    if (!role) return false;
    if (role === "H" || role === "Hn" || role === "Title") return true;
    return /^H\\d+$/.test(role);
}

function isMathMLTokenElement(tag: string): boolean {
    if (!tag) return false;
    const normalized = tag.toLowerCase();
    return normalized === "mi"
        || normalized === "mn"
        || normalized === "mo"
        || normalized === "mtext"
        || normalized === "ms";
}

function mapRoleToTag(role: string, parentRole?: string): string {
    if (role === "P" && isHeadingRoleName(parentRole)) {
        return "span";
    }
    switch (role) {
        // Grouping
        case "Document": return "div";
        case "Part": return "div";
        case "Sect": return "section";
        case "Div": return "div";
        case "Art": return "article";
        case "Aside": return "aside";
        case "Note": return "p";
        case "Index": return "section"; // §5.2: Index mapped to section
        case "NonStruct": return "div"; // Non-structural grouping
        case "Private": return "div"; // Private/proprietary content
        case "Title": return "h1"; // PDF 2.0: Title element
        case "FENote": return "aside"; // PDF 2.0: Footnote/Endnote
        // Note: "Sub" is handled as an inline element (subscript) below.
        case "DocumentFragment": return "div"; // PDF 2.0: Document fragment

        // Block
        case "P": return "p";
        case "H": return "h2"; // Default, overridden dynamically
        case "H1": return "h1";
        case "H2": return "h2";
        case "H3": return "h3";
        case "H4": return "h4";
        case "H5": return "h5";
        case "H6": return "h6";
        case "BlockQuote": return "blockquote";
        case "Caption":
            if (parentRole === "Table") return "caption";
            if (parentRole === "Figure" || parentRole === "Formula") return "figcaption";
            return "caption";
        case "TOC": return "ol"; // §5.2: Table of Contents as ordered list
        case "TOCI": return "li"; // §5.2: TOC Item as list item
        case "L": return "ul";
        case "LI": return "li";
        case "Lbl": return "span";
        case "LBody": return "div";
        case "Table": return "table";
        case "TR": return "tr";
        case "TH": return "th";
        case "TD": return "td";
        case "THead": return "thead";
        case "TBody": return "tbody";
        case "TFoot": return "tfoot";
        case "Span": return "span";
        case "Quote": return "q";
        case "Code": return "code";
        case "Em": return "em";
        case "Strong": return "strong";
        case "Sub": return "sub";
        case "Sup": return "sup";
        case "Link": return "a";
        case "Reference": return "a";
        case "BibEntry": return "p";
        case "Ruby": return "ruby";
        case "RB": return "rb";
        case "RT": return "rt";
        case "RP": return "rp";
        case "Warichu": return "span"; // Japanese inline annotation
        case "WT": return "span"; // Warichu Text
        case "WP": return "span"; // Warichu Punctuation
        case "Annot": return "span"; // General annotation
        case "Figure":
            // §6.4: Inline context check - Figure in inline parent should use span, not figure
            if (isInlineContext(parentRole)) {
                return "span";
            }
            return "figure";
        case "Formula":
            // §6.4: Inline context check - Formula in inline parent should use span, not figure
            if (isInlineContext(parentRole)) {
                return "span";
            }
            return "figure";
        case "Form": return "div";
        default: return "div";
    }
}

async function processMCR(
    context: PDFContext,
    mcr: Dict,
    inheritedPageRef: Ref | null,
    bbox?: number[],
    imageAlt?: string,
    preferVector?: boolean,
    trimText?: boolean
): Promise<RenderedContent> {
    const mcid = mcr.get("MCID");
    const pgRef = (mcr.getRaw("Pg") || inheritedPageRef) as Ref | null;

    if (!Number.isInteger(mcid) || !pgRef) return { html: "", text: "", rootTag: null };

    return await fetchContentForMCID(context, mcid as number, pgRef, bbox, imageAlt, preferVector, trimText);
}

async function processMCID(
    context: PDFContext,
    mcid: number,
    pgRef: Ref,
    bbox?: number[],
    imageAlt?: string,
    preferVector?: boolean,
    trimText?: boolean
): Promise<RenderedContent> {
    return await fetchContentForMCID(context, mcid, pgRef, bbox, imageAlt, preferVector, trimText);
}

async function fetchContentForMCID(
    context: PDFContext,
    mcid: number,
    pgRef: Ref,
    bbox?: number[],
    imageAlt?: string,
    preferVector?: boolean,
    trimText?: boolean
): Promise<RenderedContent> {
    const pageIndex = await context.pdfDocument.catalog.getPageIndex(pgRef);
    if (pageIndex === -1) return { html: "", text: "", rootTag: null };

    let extractor = context.pageContentExtractors.get(pageIndex);
    if (!extractor) {
        extractor = new ContentExtractor(pageIndex);
        const page = await context.pdfDocument.getPage(pageIndex);
        await extractor.extract(page);
        context.pageContentExtractors.set(pageIndex, extractor);
    }

    let html = "";
    let text = "";
    let hasImages = false;

    // Images
    const images = extractor.getImages(mcid);
    for (const img of images) {
        hasImages = true;
        let dataUri = "";
        let width: number | undefined;
        let height: number | undefined;
        const altValue = imageAlt ? escapeHtml(imageAlt) : "";
        const altAttr = ` alt="${altValue}"`;
        const fallbackAltAttr = imageAlt ? altAttr : ` alt="(Conversion Failed)"`;

        const bboxDims = bbox && bbox.length === 4
            ? calculateImageDimensions(Math.abs(bbox[2] - bbox[0]), Math.abs(bbox[3] - bbox[1]))
            : null;

        if (img.type === "XObject" && img.name) {
            const imageData = extractor.getImageData(img.name);
            if (imageData) {
                const rendered = imageDataToDataUri(imageData);
                if (rendered) {
                    dataUri = rendered.dataUri;
                    width = rendered.width;
                    height = rendered.height;
                }
            }

            if (!dataUri) {
                const page = await context.pdfDocument.getPage(pageIndex);
                let resources = null;
                try {
                    resources = await page.resources;
                } catch (e) {
                    console.warn("Could not load page resources", e);
                }

                if (resources && resources.get("XObject")) {
                    const xObjDict = resources.get("XObject");
                    if (xObjDict) {
                        const xObjRef = xObjDict.getRaw(img.name);
                        let xObj = null;
                        if (xObjRef) {
                            xObj = await context.xref.fetchIfRefAsync(xObjRef);
                        } else {
                            xObj = xObjDict.get(img.name);
                        }

                        if (xObj) {
                            dataUri = await convertImageXObject(context, xObj, pgRef);
                            const pdfWidth = xObj.get("Width");
                            const pdfHeight = xObj.get("Height");
                            if (pdfWidth && pdfHeight) {
                                const dims = calculateImageDimensions(pdfWidth, pdfHeight);
                                width = dims.width;
                                height = dims.height;
                            }
                        }
                    }
                }
            }

            if (bboxDims) {
                width = bboxDims.width;
                height = bboxDims.height;
            } else if (img.width && img.height && (!width || !height)) {
                const dims = calculateImageDimensions(img.width, img.height);
                width = dims.width;
                height = dims.height;
            }

            if (dataUri && width && height) {
                html += `<img src="${dataUri}" width="${width}" height="${height}"${altAttr} />`;
            } else if (dataUri) {
                html += `<img src="${dataUri}"${altAttr} />`;
            } else if (width && height) {
                html += `<img src="placeholder.png" width="${width}" height="${height}"${fallbackAltAttr} />`;
            }
        } else if (img.type === "Inline" && img.data) {
            dataUri = await convertImageXObject(context, img.data, pgRef);
            if (bboxDims) {
                width = bboxDims.width;
                height = bboxDims.height;
            } else {
                const pdfWidth = img.data.get?.("Width") || img.data.Width || 100;
                const pdfHeight = img.data.get?.("Height") || img.data.Height || 100;
                const dims = calculateImageDimensions(pdfWidth, pdfHeight);
                width = dims.width;
                height = dims.height;
            }

            if (dataUri && width && height) {
                html += `<img src="${dataUri}" width="${width}" height="${height}"${altAttr} />`;
            } else if (dataUri) {
                html += `<img src="${dataUri}"${altAttr} />`;
            } else if (width && height) {
                html += `<img src="placeholder.png" width="${width}" height="${height}"${fallbackAltAttr} />`;
            }
        }
    }

    // §9.7: Apply marked content properties
    const props = extractor.getProperties(mcid);
    let rawText = "";

    if (props?.ActualText) {
        // ActualText overrides extracted text
        rawText = String(props.ActualText);
    } else {
        rawText = extractor.getText(mcid);
    }
    const { leading: rawLeading, core: rawCore, trailing: rawTrailing } = splitEdgeWhitespace(rawText);
    const leadingWhitespace = trimText ? "" : rawLeading;
    const trailingWhitespace = trimText ? "" : rawTrailing;
    const coreText = rawCore;
    const renderedText = trimText ? rawCore : rawText;
    const escapedLeading = escapeHtml(leadingWhitespace);
    const escapedCore = escapeHtml(coreText);
    const escapedTrailing = escapeHtml(trailingWhitespace);
    const escapedText = escapeHtml(renderedText);

    const hasVector = !!(bbox && extractor.hasVectorOperators(mcid));
    const suppressText = !!(preferVector && !hasImages && hasVector);

    // Wrap with span if Lang property exists
    if (escapedText && !suppressText) {
        if (props?.Lang) {
            html += escapedLeading;
            html += `<span lang="${escapeHtml(props.Lang)}"`;
            if (props.Alt) {
                html += ` title="${escapeHtml(props.Alt)}"`;
            }
            html += `>${escapedCore}</span>`;
            html += escapedTrailing;
        } else {
            html += escapedLeading + escapedCore + escapedTrailing;
        }
        text += renderedText;
    } else if (props?.Alt && !escapedText) {
        // Alt text for non-text content
        html += `<span title="${escapeHtml(props.Alt)}"></span>`;
    }

    // Vector Graphics Rendering (§9.3)
    if (!hasImages && hasVector && (preferVector || !escapedText)) {
        try {
            // Get operators for this MCID and render as SVG
            const operators = extractor.getOperators(mcid);
            if (operators && operators.length > 0) {
    const svg = renderVectorGraphics(operators, bbox);
                if (svg) {
                    html += svg;
                }
            }
        } catch (e) {
            console.warn("Failed to render vector graphic for MCID", mcid, e);
            // Fallback to placeholder
            html += `<span data-pdf-vector="true">[Vector Graphic]</span>`;
        }
    }

    return { html, text, rootTag: null };
}

async function renderPageRegion(page: PDFPage, bbox: number[]): Promise<string> {
    // bbox is [LLx, LLy, URx, URy] (PDF coordinates)
    const scale = 2.0; // Higher quality

    // Core Page object has 'view' and 'rotate'
    const viewport = new PageViewport({
        viewBox: page.view,
        rotation: page.rotate,
        scale: scale,
        userUnit: page.userUnit || 1.0,
        dontFlip: false
    });

    // Convert to pixel coordinates
    const rect = viewport.convertToViewportRectangle(bbox);
    // rect is [xMin, yMin, xMax, yMax]
    const x = Math.min(rect[0], rect[2]);
    const y = Math.min(rect[1], rect[3]);
    let w = Math.abs(rect[2] - rect[0]);
    let h = Math.abs(rect[3] - rect[1]);

    if (w <= 0 || h <= 0) return "";

    // Limit canvas size to avoid skia errors (e.g. 4096px)
    const MAX_DIM = 4096;
    if (w > MAX_DIM || h > MAX_DIM) {
        console.warn(`Vector graphic size too large (${w}x${h}), clamping to ${MAX_DIM}.`);
        if (w > MAX_DIM) w = MAX_DIM;
        if (h > MAX_DIM) h = MAX_DIM;
    }

    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');

    // Placeholder for Vector Graphics (Rendering requires Display layer integration)
    ctx.fillStyle = "#eeeeee";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#cccccc";
    ctx.strokeRect(0, 0, w, h);

    ctx.fillStyle = "#333333";
    ctx.font = "bold 14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Vector Graphic", w / 2, h / 2);

    return canvas.toDataURL("image/png");
}

// §9.3: Render vector graphics as SVG
function renderVectorGraphics(operators: PDFOperator[], bbox: number[]): string {
    if (!bbox || bbox.length < 4) return "";

    const [x1, y1, x2, y2] = bbox;
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);

    if (width <= 0 || height <= 0) return "";

    // Limit SVG size to reasonable dimensions
    const MAX_DIM = 2000;
    let svgWidth = width;
    let svgHeight = height;

    if (width > MAX_DIM || height > MAX_DIM) {
        const scale = Math.min(MAX_DIM / width, MAX_DIM / height);
        svgWidth = width * scale;
        svgHeight = height * scale;
    }

    try {
        return generateSVG(operators, {
            width: svgWidth,
            height: svgHeight,
            viewBox: [x1, y1, width, height],
            useContentBox: true
        });
    } catch (e) {
        console.warn("SVG generation failed:", e);
        return "";
    }
}

async function processOBJR(context: PDFContext, objr: Dict, inheritedPageRef: Ref | null): Promise<RenderedContent> {
    const objRef = objr.getRaw("Obj");
    if (!objRef) return { html: "", text: "", rootTag: null };

    const obj = await context.xref.fetchIfRefAsync(objRef);
    if (!obj) return { html: "", text: "", rootTag: null };

    const subtype = obj.get("Subtype")?.name;

    if (subtype === "Widget") {
        // §10.1: Field attributes can be inherited from parent field dictionaries.
        const ftObj = await getInheritableFieldValue(context, obj, "FT");
        const ft = ftObj instanceof Name ? ftObj.name : (ftObj as { name?: unknown } | undefined)?.name;
        const ffValue = await getInheritableFieldValue(context, obj, "Ff");
        const flags = typeof ffValue === "number" ? ffValue : 0;

        let tag = "input";
        let type = "text";
        let extraAttrs = "";
        let content = "";
        let contentText = "";

        // Common Attributes
        const t = await getInheritableFieldValue(context, obj, "T");
        if (t) extraAttrs += ` name="${escapeHtml(stringToPDFString(t))}"`;

        // Generated ID
        const objId = objr.getRaw("Obj");
        // Use Ref if available, else random
        const widgetId = "widget_" + (objId ? objId.toString() : Math.random().toString(36).substr(2, 9));
        extraAttrs += ` id="${widgetId}"`;

        // Additional Actions (AA) - Field Scripts
        // Spec 11.4: "Extract from form field's additional-actions dictionary (AA)"
        const aa = await getInheritableFieldValue(context, obj, "AA");
        let script = "";
        if (aa && aa instanceof Dict) {
             // Iterate common events: K (Keystroke), F (Format), V (Validate), C (Calculate), etc.
             // We can output a script block that attaches listeners.
             // Simplest way: <script>document.getElementById('widgetId').addEventListener(...)</script>

             // Mapping PDF events to HTML events
             const events: Record<string, string> = {
                 "K": "keypress",  // Keystroke
                 "F": "blur",      // §11.4: Format - executes on blur
                 "V": "change",    // Validate
                 "C": "calculate", // Calculate (custom event)
                 "Fo": "focus",
                 "Bl": "blur",
                 "D": "mousedown",
                 "U": "mouseup",
                 "E": "mouseenter",
                 "X": "mouseleave"
             };

             let jsContent = "";
             for (const key of aa.getKeys()) {
                 const action = aa.get(key);
                 if (action && action.get("S")?.name === "JavaScript") {
                     const js = action.get("JS");
                     if (js) {
                         const jsStr = stringToPDFString(js);
                         const evt = events[key] || key;
                         jsContent += `// Event: ${key} (${evt})\n`;

                         // Hook to HTML events
                         // Format (F) and Validate (V) run on blur/change
                         // Calculate (C) is triggered by calculateNow()
                         if (key === "K") {
                             jsContent += `document.getElementById('${widgetId}').addEventListener('keypress', function(event) { ${jsStr} });\n`;
                         } else if (key === "F") {
                             // §11.4: Format script runs on blur
                             jsContent += `document.getElementById('${widgetId}').addEventListener('blur', function(event) { ${jsStr} });\n`;
                         } else if (key === "V") {
                             jsContent += `document.getElementById('${widgetId}').addEventListener('change', function(event) { ${jsStr} });\n`;
                         } else if (key === "C") {
                             // Calculate - handled by runtime calculateNow()
                             jsContent += `// Calculate event - triggered by calculateNow()\n`;
                             // Store calculation expression as data attribute
                             extraAttrs += ` data-calculate="${escapeHtml(jsStr).replace(/"/g, '&quot;')}"`;
                         } else if (evt === "focus" || evt === "blur" || evt === "mousedown" || evt === "mouseup" || evt === "mouseenter" || evt === "mouseleave") {
                             jsContent += `document.getElementById('${widgetId}').addEventListener('${evt}', function(event) { ${jsStr} });\n`;
                         }
                     }
                 }
             }

             if (jsContent) {
                 script = `<script>\n${jsContent}\n</script>`;
             }
        }

        const maxLen = await getInheritableFieldValue(context, obj, "MaxLen");
        if (typeof maxLen === 'number') extraAttrs += ` maxlength="${maxLen}"`;

        // §10.2: Bit 25 - Comb (character separation for text fields)
        // Only applies to single-line text fields with MaxLen
        if (ft === "Tx" && (flags & 16777216) && maxLen && !(flags & 4096) && !(flags & 8192) && !(flags & 1048576)) {
            // Calculate letter-spacing based on field width and max length
            // Use 1em spacing as reasonable default
            extraAttrs += ` style="letter-spacing: 1em; text-align: center"`;
        }

        // Flags
        // Bit 1: ReadOnly
        if (flags & 1) extraAttrs += ` readonly`;
        // Bit 2: Required
        if (flags & 2) extraAttrs += ` required`;
        // Bit 3: NoExport
        if (flags & 4) extraAttrs += ` data-pdf-no-export="true"`;

        if (ft === "Btn") {
            if (flags & 32768) { // Radio
                type = "radio";
                // Get export value from AP (Appearance) dictionary or AS (Appearance State)
                const as = obj.get("AS");
                if (as && as instanceof Name && as.name !== "Off") {
                    extraAttrs += ` value="${escapeHtml(as.name)}"`;
                } else {
                    // Try to get from AP/N keys
                    const ap = obj.get("AP");
                    if (ap && ap instanceof Dict) {
                        const n = ap.get("N");
                        if (n && n instanceof Dict) {
                            const keys = n.getKeys();
                            for (const key of keys) {
                                if (key !== "Off") {
                                    extraAttrs += ` value="${escapeHtml(key)}"`;
                                    break;
                                }
                            }
                        }
                    }
                }
                // Check if this radio is selected
                const v = await getInheritableFieldValue(context, obj, "V");
                const as2 = obj.get("AS");
                if (v && as2 && v instanceof Name && as2 instanceof Name && v.name === as2.name && v.name !== "Off") {
                    extraAttrs += ` checked`;
                }
            } else if (flags & 65536) { // PushButton
                // Check for Submit/Reset actions
                const a = await getInheritableFieldValue(context, obj, "A");
                let buttonType = "button";

                if (a && a instanceof Dict) {
                    const actionType = a.get("S")?.name;
                    if (actionType === "SubmitForm") {
                        buttonType = "submit";
                    } else if (actionType === "ResetForm") {
                        buttonType = "reset";
                    }
                }

                type = buttonType;

                // Get button label from TU (tooltip) or T (name)
                const tu = await getInheritableFieldValue(context, obj, "TU");
                const t2 = await getInheritableFieldValue(context, obj, "T");
                let label = "";
                if (tu) label = stringToPDFString(tu);
                else if (t2) label = stringToPDFString(t2);

                if (label) {
                    if (type === "submit" || type === "reset") {
                        extraAttrs += ` value="${escapeHtml(label)}"`;
                    } else {
                        content = escapeHtml(label);
                        contentText = label;
                        tag = "button";
                    }
                }
            } else { // Checkbox
                type = "checkbox";
                // Check state
                const v = await getInheritableFieldValue(context, obj, "V");
                if (v instanceof Name && v.name !== "Off") {
                    extraAttrs += ` checked`;
                }
            }

        } else if (ft === "Tx") {
            type = "text";

            // §10.2: Bit 21 - FileSelect
            if (flags & 1048576) {
                type = "file";
                // File select fields don't have values (for security)
            } else if (flags & 4096) {
                // Bit 13: Multiline
                tag = "textarea";
                type = ""; // textarea doesn't have type attribute
                const v = await getInheritableFieldValue(context, obj, "V");
                if (typeof v === 'string') {
                    content = escapeHtml(v);
                    contentText = v;
                }
            } else {
                // Bit 14: Password
                if (flags & 8192) type = "password";

                const v = await getInheritableFieldValue(context, obj, "V");
                if (typeof v === 'string') {
                    extraAttrs += ` value="${escapeHtml(v)}"`;
                }
            }
        } else if (ft === "Sig") {
            // Signature field - render as readonly text input with signature indicator
            type = "text";
            extraAttrs += ` readonly data-pdf-field-type="signature"`;

            const v = await getInheritableFieldValue(context, obj, "V");
            if (v) {
                // Signature is present
                extraAttrs += ` value="[Digitally Signed]" data-pdf-signed="true"`;
            } else {
                extraAttrs += ` placeholder="[Unsigned]"`;
            }
        } else if (ft === "Ch") {
             // Choice
             tag = "select";
             type = ""; // select doesn't have type

             // Bit 18: Combo (Edit allowed?)
             // Bit 19: Edit (If Combo set)
             // Bit 22: MultiSelect
             if (flags & 2097152) extraAttrs += ` multiple`;

             const opts = await getInheritableFieldValue(context, obj, "Opt");
             const v = await getInheritableFieldValue(context, obj, "V"); // Selected value(s)
             const i = await getInheritableFieldValue(context, obj, "I"); // Selected index(es)

             // Determine selected values
             let selectedValues: string[] = [];
             if (Array.isArray(v)) {
                 selectedValues = v.map((val: unknown) => {
                     if (typeof val === "string") return stringToPDFString(val);
                     return "";
                 });
             } else if (typeof v === 'string') {
                 selectedValues = [stringToPDFString(v)];
             }

             if (Array.isArray(opts)) {
                 for (const opt of opts) {
                     let value = "";
                     let label = "";

                     if (Array.isArray(opt)) {
                         // [ExportValue, Label]
                         value = typeof opt[0] === 'string' ? stringToPDFString(opt[0]) : "";
                         label = typeof opt[1] === 'string' ? stringToPDFString(opt[1]) : "";
                     } else if (typeof opt === 'string') {
                         value = stringToPDFString(opt);
                         label = stringToPDFString(opt);
                     }

                     let selected = "";
                     if (selectedValues.includes(value)) {
                         selected = " selected";
                     }

                     content += `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
                     if (label) {
                         contentText += (contentText ? " " : "") + label;
                     }
                 }
             }
        }

        if (tag === "input") {
            if (type) {
                return { html: `<${tag} type="${type}"${extraAttrs}/>${script}`, text: "", rootTag: "input" };
            } else {
                return { html: `<${tag}${extraAttrs}/>${script}`, text: "", rootTag: "input" };
            }
        } else if (tag === "button") {
            return { html: `<${tag}${extraAttrs}>${content}</${tag}>${script}`, text: contentText, rootTag: "button" };
        } else {
            return { html: `<${tag}${extraAttrs}>${content}</${tag}>${script}`, text: contentText, rootTag: tag };
        }
    }

    if (subtype === "Image") {
         const dataUri = await convertImageXObject(context, obj, inheritedPageRef);
         const pdfWidth = obj.get("Width");
         const pdfHeight = obj.get("Height");
         const { width, height } = calculateImageDimensions(pdfWidth, pdfHeight);
         const alt = "PDF Image";

         if (dataUri) {
             return { html: `<img src="${dataUri}" width="${width}" height="${height}" alt="${alt}"/>`, text: "", rootTag: "img" };
         } else {
             return { html: `<img src="placeholder.png" width="${width}" height="${height}" alt="${alt} (Conversion Failed)"/>`, text: "", rootTag: "img" };
         }
    }

    return { html: "", text: "", rootTag: null };
}

// §6.7: Link processing with structured destination support
async function processLink(
    context: PDFContext,
    childOrRef: StructChild,
    child: Dict,
    attributes: PDFAttributes,
    classes: unknown,
    inheritedPageRef: Ref | null,
    traversalCtx: TraversalContext
): Promise<RenderedContent> {
    let href = "";

    const resolveActionHref = (action: Dict): string => {
        const actionType = action.get("S")?.name;
        if (actionType === "URI") {
            const uri = action.get("URI");
            if (uri) return stringToPDFString(uri);
        } else if (actionType === "GoTo") {
            const dest = action.get("D");
            if (dest) return convertDestToFragment(dest, context, traversalCtx.idState);
        } else if (actionType === "GoToR") {
            const f = action.get("F");
            const dest = action.get("D");
            const file = typeof f === "string" ? f : f?.get?.("F");
            if (file && dest) return `${stringToPDFString(file)}${convertDestToFragment(dest, context, traversalCtx.idState)}`;
            if (file) return stringToPDFString(file);
        } else if (actionType === "Launch") {
            const f = action.get("F");
            const file = typeof f === "string" ? f : f?.get?.("F");
            if (file) return stringToPDFString(file);
        }
        return "";
    };

    // Direct action/destination on the structure element
    const directAction = child.get("A");
    if (directAction instanceof Dict) {
        href = resolveActionHref(directAction);
    }
    if (!href) {
        const directDest = child.get("Dest");
        if (directDest) href = convertDestToFragment(directDest, context, traversalCtx.idState);
    }

    // Try to find destination/URI in children OBJR
    const findHref = async (node: Dict) => {
        const k = node.get("K");
        let children = [];
        if (Array.isArray(k)) children = k;
        else if (k) children = [k];

        for (const childOrRef of children) {
            const child = context.xref.fetchIfRef(childOrRef);
            if (!child) continue;

            if (child instanceof Dict) {
                if (child.get("Type")?.name === "OBJR") {
                    const objRef = child.getRaw("Obj");
                    const obj = await context.xref.fetchIfRefAsync(objRef);
                    if (obj && obj.get("Subtype")?.name === "Link") {
                        const a = obj.get("A");
                        if (a) {
                            href = resolveActionHref(a);
                        }

                        // Fallback: Check Dest entry directly on annotation
                        if (!href) {
                            const dest = obj.get("Dest");
                            if (dest) {
                                href = convertDestToFragment(dest, context, traversalCtx.idState);
                            }
                        }
                    }
                }
            }
        }
    };

    if (!href) {
        await findHref(child);
    }

    let attrs = getHTMLAttributes(attributes);
    const sType = (child.get("S") as Name | undefined)?.name;
    const roleMap = context.structTreeRoot?.roleMap;
    const namespaceURI = getNamespaceURI(context, child);
    const mappedRole = sType ? resolveRole(sType, roleMap, namespaceURI) : "";

    if (mappedRole) {
        attrs += ` data-pdf-se-type="${escapeHtml(mappedRole)}"`;
    }
    if (sType && sType !== mappedRole) {
        attrs += ` data-pdf-se-type-original="${escapeHtml(sType)}"`;
    }
    if (href) attrs += ` href="${escapeHtml(href)}"`;

    const id = child.get("ID") as string | undefined;
    const lang = child.get("Lang") as string | undefined;
    const title = child.get("T") as string | undefined;

    if (id) {
        attrs += ` id="${escapeHtml(stringToPDFString(id))}"`;
    } else {
        const generatedId = ensureGeneratedId(childOrRef, child, traversalCtx.idState);
        attrs += ` id="${escapeHtml(generatedId)}"`;
    }
    if (lang) attrs += ` lang="${escapeHtml(stringToPDFString(lang))}"`;
    if (title) attrs += ` title="${escapeHtml(stringToPDFString(title))}"`;

    const pronunciationHint = getPronunciationHint(attributes);
    if (pronunciationHint) {
        attrs += ` data-pdf-pronunciation="${escapeHtml(pronunciationHint)}"`;
    }

    if (classes) {
        let classStr = "";
        const toClassName = (value: unknown): string => {
            if (value instanceof Name) return value.name;
            if (value && typeof (value as { name?: unknown }).name === "string") {
                return String((value as { name: string }).name);
            }
            if (typeof value === "string") return value;
            return stringToPDFString(value);
        };

        if (Array.isArray(classes)) {
             classStr = classes.map((c: unknown) => toClassName(c)).filter(Boolean).join(" ");
        } else {
             classStr = toClassName(classes);
        }
        if (classStr) attrs += ` class="${escapeHtml(classStr)}"`;
    }

    const style = getCSSProperties(attributes);
    if (style) attrs += ` style="${escapeHtml(style)}"`;

    const actualText = child.get("ActualText") as string | undefined;
    let content = "";
    let contentText = "";
    if (actualText) {
        contentText = stringToPDFString(actualText);
        content = escapeHtml(contentText);
    } else {
        const children = child.get("K");
        const rendered = await processChildren(context, children, inheritedPageRef, traversalCtx);
        content = rendered.html;
        contentText = rendered.text;
    }

    const expansionText = child.get("E") as string | undefined;
    if (expansionText) {
        const eVal = escapeHtml(stringToPDFString(expansionText));
        content = `<abbr title="${eVal}">${content}</abbr>`;
    }

    return { html: `<a${attrs}>${content}</a>`, text: contentText, rootTag: "a" };
}

// §9.3: Calculate HTML image dimensions from PDF dimensions
// Formula: (PDF_dimension / 72) * 96
// Converts from PDF points (72 DPI) to HTML pixels (96 DPI at 28" viewing distance)
function calculateImageDimensions(pdfWidth: number, pdfHeight: number): { width: number, height: number } {
    const width = Math.round((pdfWidth / 72) * 96);
    const height = Math.round((pdfHeight / 72) * 96);
    return { width, height };
}

function imageDataToDataUri(imageData: any): { dataUri: string; width: number; height: number } | null {
    if (!imageData) return null;

    const width = imageData.width || imageData.bitmap?.width;
    const height = imageData.height || imageData.bitmap?.height;
    if (!width || !height) return null;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    if (imageData.data && imageData.data.length) {
        const img = ctx.createImageData(width, height);
        const kind = imageData.kind;

        if (kind === ImageKind.RGB_24BPP || kind === ImageKind.GRAYSCALE_1BPP) {
            const dest = new Uint32Array(img.data.buffer);
            convertToRGBA({
                kind,
                src: imageData.data,
                dest,
                width,
                height
            });
        } else if (imageData.data.length === img.data.length) {
            img.data.set(imageData.data);
        } else if (imageData.data.length === width * height * 3) {
            let srcPos = 0;
            for (let i = 0; i < width * height; i++) {
                const destPos = i * 4;
                img.data[destPos] = imageData.data[srcPos++];
                img.data[destPos + 1] = imageData.data[srcPos++];
                img.data[destPos + 2] = imageData.data[srcPos++];
                img.data[destPos + 3] = 255;
            }
        } else {
            img.data.set(imageData.data.subarray(0, img.data.length));
        }
        ctx.putImageData(img, 0, 0);
    } else if (imageData.bitmap) {
        ctx.drawImage(imageData.bitmap, 0, 0);
    } else {
        return null;
    }

    return { dataUri: canvas.toDataURL("image/png"), width, height };
}

// §6.7: Convert PDF destination to HTML fragment identifier
// §6.7: PDF 2.0 structured destinations can target structure elements directly.
function getStructElementIdFromDest(context: PDFContext, dest: unknown, idState: IdState): string | null {
    if (!dest) return null;

    if (Array.isArray(dest) && dest.length > 0) {
        return getStructElementIdFromDest(context, dest[0], idState);
    }

    let destObj: unknown = dest;
    let destRef: Ref | null = null;
    if (dest instanceof Ref) {
        destRef = dest;
        destObj = context.xref.fetchIfRef(dest);
    }

    if (!(destObj instanceof Dict)) return null;

    const typeName = destObj.get("Type")?.name;
    const structType = destObj.get("S")?.name;
    if (typeName !== "StructElem" && !structType) return null;

    const idValue = destObj.get("ID") as string | undefined;
    if (idValue) return stringToPDFString(idValue);

    return ensureGeneratedId(destRef ?? destObj, destObj, idState);
}

function convertDestToFragment(dest: unknown, context?: PDFContext, idState?: IdState): string {
    if (!dest) return "";

    // Destination can be:
    // 1. Name (string) - named destination
    // 2. Array - [page, /XYZ, left, top, zoom] or similar
    // 3. String - named destination
    if (context && idState) {
        const structId = getStructElementIdFromDest(context, dest, idState);
        if (structId) return `#${encodeURIComponent(structId)}`;
    }

    if (typeof dest === 'string') {
        // Named destination
        return `#${encodeURIComponent(dest)}`;
    }

    if (dest instanceof Name) {
        return `#${encodeURIComponent(dest.name)}`;
    }

    if (Array.isArray(dest) && dest.length > 0) {
        // Explicit destination: [page, type, ...]
        const page = dest[0];
        // Try to create a fragment from page ref
        // In HTML output, we'd need to assign IDs to pages
        // For now, use page-N format
        if (page && typeof page === 'object') {
            // Page reference - would need to resolve to page number
            // Simplified: use #page
            return "#page";
        }
    }

    return "#";
}

// §6.4: Determine if parent role represents inline context
function isInlineContext(parentRole: string | undefined): boolean {
    if (!parentRole) return false;
    if (isHeadingRoleName(parentRole)) return true;

    // Inline structure types that cannot contain block-level elements
    const inlineTypes = new Set([
        "Span", "Quote", "Reference", "BibEntry", "Code", "Link",
        "Annot", "Ruby", "RB", "RT", "RP", "Warichu", "WT", "WP",
        "P", "H", "H1", "H2", "H3", "H4", "H5", "H6",
        "Em", "Strong", "Sub", "Sup", "TH", "TD"
    ]);

    return inlineTypes.has(parentRole);
}

// §4.3.2.3: Transitive role mapping - follow RoleMap until standard type reached
function isPdfStandardNamespace(namespaceURI: string | undefined): boolean {
    if (!namespaceURI) return true;
    const normalized = namespaceURI.trim().toLowerCase();
    if (!normalized) return true;
    if (normalized === "http://iso.org/pdf2/ssn") return true;
    if (normalized === "http://iso.org/pdf2/ssn#") return true;
    if (normalized === "http://iso.org/pdf2/ssn/1.0") return true;
    if (normalized === "http://iso.org/pdf/ssn") return true;
    if (normalized === "http://iso.org/pdf/ssn/1.0") return true;
    return false;
}

function resolveRole(role: string, roleMap?: Map<string, string>, namespaceURI?: string): string {
    if (!role) return role;
    if (isPdfStandardNamespace(namespaceURI) && isStandardType(role)) return role;

    let current = role;
    const seen = new Set<string>();

    // Follow role mapping transitively
    while (roleMap && roleMap.has(current) && !seen.has(current)) {
        // Detect cycles
        seen.add(current);

        const next = roleMap.get(current);
        if (!next) break;

        current = next;

        // Stop if we've reached a standard structure type (§14.8.4 Table 337)
        if (isStandardType(current)) {
            break;
        }
    }

    return current;
}

// Check if role is a standard PDF structure type
function isStandardType(role: string): boolean {
    if (role === "Hn") return true;
    if (/^H\\d+$/.test(role)) return true;
    const standardTypes = new Set([
        // Grouping elements (§14.8.4.2)
        "Document", "Part", "Sect", "Div", "Art", "BlockQuote", "Caption",
        "TOC", "TOCI", "Index", "NonStruct", "Private", "Aside",
        "Title", "FENote", "DocumentFragment",

        // Paragraph-like elements (§14.8.4.3)
        "P", "H", "H1", "H2", "H3", "H4", "H5", "H6",

        // List elements (§14.8.4.3.3)
        "L", "LI", "Lbl", "LBody",

        // Table elements (§14.8.4.3.4)
        "Table", "TR", "TH", "TD", "THead", "TBody", "TFoot",

        // Inline elements (§14.8.4.4)
        "Span", "Quote", "Note", "Reference", "BibEntry", "Code", "Link",
        "Annot", "Ruby", "RB", "RT", "RP", "Warichu", "WT", "WP",
        "Em", "Strong", "Sub", "Sup",

        // Illustration elements (§14.8.4.5)
        "Figure", "Formula", "Form",

        // Artifact
        "Artifact"
    ]);

    return standardTypes.has(role);
}
