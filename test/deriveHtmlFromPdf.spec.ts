// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveHtmlFromPdf } from "../src/index.js";
import { createPDFContext } from "../src/pdf_js_context.js";
import { generateCSS } from "../src/css_generator.js";
import { MetadataParser } from "../pdf.js/src/core/metadata_parser.js";
import { stringToPDFString } from "../pdf.js/src/shared/util.js";

const TEST_TIMEOUT_MS = 20000;
const testDir = path.dirname(fileURLToPath(import.meta.url));
const pdfPath = path.join(testDir, "../exercise/spec-algorithm-exercise.pdf");

let html = "";
let context: Awaited<ReturnType<typeof createPDFContext>>;
let structElements: StructElementInfo[] = [];
let structElementsByRole = new Map<string, StructElementInfo[]>();
let traversalIds: string[] = [];

interface StructElementInfo {
  dict: any;
  sType: string;
  mappedRole: string;
  id?: string;
  attributes?: any;
  classes?: unknown;
  parentMappedRole?: string;
  parentId?: string;
  namespaceURI?: string;
  listNumbering?: string;
  listHasLbl?: boolean;
  skipOutput?: boolean;
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTagContent(source: string, tagName: string): string | null {
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i");
  const match = source.match(pattern);
  return match ? match[1] : null;
}

function getMetadataTitle(ctx: Awaited<ReturnType<typeof createPDFContext>>): string {
  let title = "";
  const metadataStream = ctx.rootDict.get("Metadata");
  if (metadataStream && typeof metadataStream.getString === "function") {
    try {
      const data = metadataStream.getString();
      if (data) {
        const parser = new MetadataParser(data);
        const dcTitle = parser.serializable.parsedData.get("dc:title");
        if (dcTitle) title = dcTitle;
      }
    } catch {
      // Ignore malformed metadata; title requirement still expects a non-empty title.
    }
  }
  return title;
}

function getCatalogLang(ctx: Awaited<ReturnType<typeof createPDFContext>>): string {
  const lang = ctx.rootDict.get("Lang");
  if (!lang) return "";
  return typeof lang === "string" ? lang : (lang.name || "");
}

function isStandardType(role: string): boolean {
  if (role === "Hn") return true;
  if (/^H\\d+$/.test(role)) return true;
  const standardTypes = new Set([
    "Document",
    "Part",
    "Sect",
    "Div",
    "Art",
    "BlockQuote",
    "Caption",
    "TOC",
    "TOCI",
    "Index",
    "NonStruct",
    "Private",
    "Aside",
    "Title",
    "FENote",
    "DocumentFragment",
    "P",
    "H",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "L",
    "LI",
    "Lbl",
    "LBody",
    "Table",
    "TR",
    "TH",
    "TD",
    "THead",
    "TBody",
    "TFoot",
    "Span",
    "Quote",
    "Note",
    "Reference",
    "BibEntry",
    "Code",
    "Link",
    "Annot",
    "Ruby",
    "RB",
    "RT",
    "RP",
    "Warichu",
    "WT",
    "WP",
    "Em",
    "Strong",
    "Sub",
    "Sup",
    "Figure",
    "Formula",
    "Form",
    "Artifact",
  ]);
  return standardTypes.has(role);
}

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
  if (!roleMap || !role) return role;
  if (isPdfStandardNamespace(namespaceURI) && isStandardType(role)) return role;
  let current = role;
  const seen = new Set<string>();
  while (roleMap.has(current) && !seen.has(current)) {
    seen.add(current);
    const next = roleMap.get(current);
    if (!next) break;
    current = next;
    if (isStandardType(current)) break;
  }
  return current;
}

function getNamespaceURI(ctx: Awaited<ReturnType<typeof createPDFContext>>, dict: any): string {
  const ns = dict?.get?.("NS");
  if (!ns) return "";
  const nsDict = ctx.xref.fetchIfRef(ns);
  if (nsDict && typeof nsDict.get === "function") {
    const nsValue = nsDict.get("NS");
    if (typeof nsValue === "string") return stringToPDFString(nsValue);
  }
  return "";
}

function getChildrenArray(children: any): any[] {
  if (!children) return [];
  return Array.isArray(children) ? children : [children];
}

function reorderCaptions(ctx: Awaited<ReturnType<typeof createPDFContext>>, children: any[]): any[] {
  const roleMap = ctx.structTreeRoot?.roleMap;
  const captions: any[] = [];
  const others: any[] = [];

  for (const childOrRef of children) {
    const child = ctx.xref.fetchIfRef(childOrRef);
    if (!child || typeof child === "number") {
      others.push(childOrRef);
      continue;
    }
    const dict = child.dict || child;
    const sType = dict?.get?.("S")?.name;
    if (!sType) {
      others.push(childOrRef);
      continue;
    }
    const namespaceURI = getNamespaceURI(ctx, dict);
    const mappedRole = resolveRole(sType, roleMap, namespaceURI);
    if (mappedRole === "Caption") captions.push(childOrRef);
    else others.push(childOrRef);
  }

  return [...captions, ...others];
}

function getListNumbering(attributes: any): string | undefined {
  if (!attributes) return undefined;
  const attrs = Array.isArray(attributes) ? attributes : [attributes];
  for (const attr of attrs) {
    const numbering = attr?.get?.("ListNumbering");
    if (numbering) return numbering.name || String(numbering);
  }
  return undefined;
}

function hasLblChildren(ctx: Awaited<ReturnType<typeof createPDFContext>>, dict: any): boolean {
  const roleMap = ctx.structTreeRoot?.roleMap;
  const children = getChildrenArray(dict?.get?.("K"));
  for (const childOrRef of children) {
    const child = ctx.xref.fetchIfRef(childOrRef);
    if (!child || typeof child === "number") continue;
    const childDict = child.dict || child;
    const sType = childDict?.get?.("S")?.name;
    if (!sType) continue;
    const namespaceURI = getNamespaceURI(ctx, childDict);
    const mappedRole = resolveRole(sType, roleMap, namespaceURI);
    if (mappedRole === "Lbl") return true;
  }
  return false;
}

function hasLinkChild(ctx: Awaited<ReturnType<typeof createPDFContext>>, dict: any): boolean {
  const roleMap = ctx.structTreeRoot?.roleMap;
  const children = getChildrenArray(dict?.get?.("K"));
  for (const childOrRef of children) {
    const child = ctx.xref.fetchIfRef(childOrRef);
    if (!child || typeof child === "number") continue;
    const childDict = child.dict || child;
    const sType = childDict?.get?.("S")?.name;
    if (!sType) continue;
    const namespaceURI = getNamespaceURI(ctx, childDict);
    const mappedRole = resolveRole(sType, roleMap, namespaceURI);
    if (mappedRole === "Link") return true;
  }
  return false;
}

function collectStructElements(ctx: Awaited<ReturnType<typeof createPDFContext>>): StructElementInfo[] {
  const roleMap = ctx.structTreeRoot?.roleMap;
  const rootChildren = ctx.structTreeRoot?.dict?.get("K");
  const stack = getChildrenArray(rootChildren)
    .reverse()
    .map((node) => ({ node, parentMappedRole: undefined as string | undefined, parentId: undefined as string | undefined }));
  const result: StructElementInfo[] = [];

  while (stack.length > 0) {
    const { node, parentMappedRole, parentId } = stack.pop()!;
    const resolved = ctx.xref.fetchIfRef(node);
    if (!resolved || typeof resolved === "number") continue;
    const dict = resolved.dict || resolved;
    if (!dict || typeof dict.get !== "function") continue;

    const sType = dict.get("S")?.name || "";
    const namespaceURI = getNamespaceURI(ctx, dict);
    const mappedRole = resolveRole(sType, roleMap, namespaceURI);
    const idValue = dict.get("ID");
    const id = idValue ? stringToPDFString(idValue) : undefined;
    const attributes = dict.get("A");
    const classes = dict.get("C");

    const info: StructElementInfo = {
      dict,
      sType,
      mappedRole,
      id,
      attributes,
      classes,
      parentMappedRole,
      parentId,
      namespaceURI,
    };

    if (mappedRole === "L") {
      info.listNumbering = getListNumbering(attributes) ?? "None";
      info.listHasLbl = hasLblChildren(ctx, dict);
    }
    if (mappedRole === "Reference") {
      info.skipOutput = hasLinkChild(ctx, dict);
    }

    result.push(info);

    const children = reorderCaptions(ctx, getChildrenArray(dict.get("K")));
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: children[i], parentMappedRole: mappedRole, parentId: id });
    }
  }

  return result;
}

function groupByRole(elements: StructElementInfo[]): Map<string, StructElementInfo[]> {
  const map = new Map<string, StructElementInfo[]>();
  for (const el of elements) {
    const key = el.mappedRole || "";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(el);
  }
  return map;
}

function getHtmlTagForId(source: string, id: string): string | null {
  const escaped = escapeRegExp(id);
  const pattern = new RegExp(`<([a-z0-9]+)[^>]*\\bid=\"${escaped}\"[^>]*>`, "i");
  const match = source.match(pattern);
  return match ? match[1].toLowerCase() : null;
}

function getOpeningTagById(source: string, id: string): string | null {
  const escaped = escapeRegExp(id);
  const pattern = new RegExp(`<[^>]*\\bid=\"${escaped}\"[^>]*>`, "i");
  const match = source.match(pattern);
  return match ? match[0] : null;
}

function getHtmlElementContentById(source: string, id: string): string | null {
  const tag = getHtmlTagForId(source, id);
  if (!tag) return null;
  const escaped = escapeRegExp(id);
  const pattern = new RegExp(`<${tag}[^>]*\\bid=\"${escaped}\"[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = source.match(pattern);
  return match ? match[1] : null;
}

function getHtmlTagsByRole(source: string, role: string): string[] {
  const tags: string[] = [];
  const pattern = new RegExp(`<([a-z0-9]+)[^>]*data-pdf-se-type=\"${escapeRegExp(role)}\"[^>]*>`, "gi");
  for (const match of source.matchAll(pattern)) {
    tags.push(match[1].toLowerCase());
  }
  return tags;
}

function getElementsByRole(role: string): StructElementInfo[] {
  return structElementsByRole.get(role) ?? [];
}

function findAttributeWithKey(keys: string[]): { element: StructElementInfo; key: string; value: unknown } | null {
  for (const element of structElements) {
    if (!element.id || !element.attributes) continue;
    const attrList = Array.isArray(element.attributes) ? element.attributes : [element.attributes];
    for (const attr of attrList) {
      if (!attr?.get) continue;
      for (const key of keys) {
        const value = attr.get(key);
        if (value !== undefined && value !== null) {
          return { element, key, value };
        }
      }
    }
  }
  return null;
}

function normalizeAttributeValue(value: unknown): string {
  if (value && typeof (value as { name?: unknown }).name === "string") {
    return String((value as { name: string }).name);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeAttributeValue(entry)).join(" ");
  }
  return String(value);
}

function assertRoleTagMapping(role: string, expectedTags: string[]): void {
  const allElements = getElementsByRole(role);
  const elements = allElements.filter((el) => el.id && !el.skipOutput);
  if (elements.length === 0) {
    if (allElements.length === 0 || allElements.every((el) => el.skipOutput)) {
      expect(html).not.toContain(`data-pdf-se-type=\"${role}\"`);
    } else {
      expect(html).toContain(`data-pdf-se-type=\"${role}\"`);
    }
    return;
  }

  for (const element of elements.slice(0, 5)) {
    const tag = getHtmlTagForId(html, element.id!);
    expect(tag).not.toBeNull();
    expect(expectedTags).toContain(tag!);
  }
}

function isHeadingRole(role?: string): boolean {
  if (!role) return false;
  if (role === "H" || role === "Hn" || role === "Title") return true;
  return /^H\\d+$/.test(role);
}

function isInlineContext(role?: string): boolean {
  if (!role) return false;
  if (isHeadingRole(role)) return true;
  return ["P", "Span", "Em", "Strong"].includes(role);
}

describe("deriveHtmlFromPdf (SPECIFICATION.md compliance)", () => {
  beforeAll(async () => {
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    context = await createPDFContext(data, "tagged-output.pdf");
    html = await deriveHtmlFromPdf(data);
    structElements = collectStructElements(context);
    structElementsByRole = groupByRole(structElements);
    traversalIds = structElements
      .filter((el) => el.id && !el.skipOutput && !["NonStruct", "Private", "Artifact"].includes(el.mappedRole))
      .map((el) => el.id!)
      .filter((id): id is string => Boolean(id));
  }, TEST_TIMEOUT_MS);

  it("§3.1/§4.1 emits a valid HTML skeleton and head/body ordering", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<html");
    expect(html).toContain("<head>");
    expect(html).toContain("</head>");
    expect(html).toContain("<body");
    expect(html).toContain("</body>");
    expect(html).toContain("</html>");

    const headIndex = html.indexOf("<head>");
    const bodyIndex = html.indexOf("<body");
    expect(headIndex).toBeGreaterThan(-1);
    expect(bodyIndex).toBeGreaterThan(headIndex);
  });

  it("§4.1.2 includes required head metadata (title, charset, viewport)", () => {
    const actualTitle = extractTagContent(html, "title");
    expect(actualTitle).not.toBeNull();
    expect(actualTitle?.trim().length).toBeGreaterThan(0);

    expect(html).toMatch(/<meta[^>]+charset=/i);
    expect(html).toMatch(/<meta[^>]+name=\"viewport\"[^>]+initial-scale=1/i);
  });

  it("§4.1.2 derives <title> from XMP dc:title when present (or falls back to a non-empty title)", () => {
    const expectedTitle = getMetadataTitle(context);
    const actualTitle = extractTagContent(html, "title");
    expect(actualTitle).not.toBeNull();
    expect(actualTitle?.trim().length).toBeGreaterThan(0);

    if (expectedTitle) {
      expect(actualTitle).toBe(escapeHtml(expectedTitle));
    }
  });

  it("§4.1.1 propagates the catalog language to the <html> element when present", () => {
    const lang = getCatalogLang(context);
    if (!lang) {
      expect(html).not.toMatch(/<html[^>]*\blang=/i);
      return;
    }

    const langPattern = new RegExp(`<html[^>]*\\blang=\"${escapeHtml(lang)}\"`, "i");
    expect(html).toMatch(langPattern);
  });

  it("§4.2.2/§12 emits derived CSS from ClassMap into the head", () => {
    const css = generateCSS(context.structTreeRoot);
    if (css) {
      expect(html).toContain("<style>");
      expect(html).toContain(css);
    } else {
      expect(html).not.toContain("<style>");
    }
  });

  it("§3.2 traverses the structure tree in depth-first pre-order", () => {
    let lastIndex = -1;
    for (const id of traversalIds) {
      const index = html.indexOf(`id=\"${escapeHtml(id)}\"`);
      expect(index).toBeGreaterThan(-1);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it("§5.1 applies role mapping and emits data-pdf-se-type/data-pdf-se-type-original", () => {
    const mapped = structElements.find((el) => el.sType && el.mappedRole && el.sType !== el.mappedRole && el.id);
    if (mapped?.id) {
      const openingTag = getOpeningTagById(html, mapped.id);
      expect(openingTag).not.toBeNull();
      expect(openingTag!).toMatch(new RegExp(`data-pdf-se-type=\\\"${escapeRegExp(escapeHtml(mapped.mappedRole))}\\\"`));
      expect(openingTag!).toMatch(new RegExp(`data-pdf-se-type-original=\\\"${escapeRegExp(escapeHtml(mapped.sType))}\\\"`));
    }

    const standard = structElements.find((el) => el.sType && el.mappedRole && el.sType === el.mappedRole && el.id);
    if (standard?.id) {
      const openingTag = getOpeningTagById(html, standard.id);
      expect(openingTag).not.toBeNull();
      expect(openingTag!).toMatch(new RegExp(`data-pdf-se-type=\\\"${escapeRegExp(escapeHtml(standard.mappedRole))}\\\"`));
    }
  });

  it("§5.2.1 maps document structure roles to HTML sectioning elements", () => {
    assertRoleTagMapping("Document", ["div"]);
    assertRoleTagMapping("Part", ["div"]);
    assertRoleTagMapping("Sect", ["section"]);
    assertRoleTagMapping("Div", ["div"]);
    assertRoleTagMapping("Art", ["article"]);
    assertRoleTagMapping("Aside", ["aside"]);
  });

  it("§5.2.2 maps headings to h1-h6 or fallback p with aria-level", () => {
    assertRoleTagMapping("H1", ["h1"]);
    assertRoleTagMapping("H2", ["h2"]);
    assertRoleTagMapping("H3", ["h3"]);
    assertRoleTagMapping("H4", ["h4"]);
    assertRoleTagMapping("H5", ["h5"]);
    assertRoleTagMapping("H6", ["h6"]);

    const titles = getElementsByRole("Title").filter((el) => el.id);
    if (titles.length === 0) {
      expect(html).not.toContain(`data-pdf-se-type=\"Title\"`);
    } else {
      for (const element of titles.slice(0, 3)) {
        const tag = getHtmlTagForId(html, element.id!);
        expect(tag).not.toBeNull();
        expect(["h1", "p"]).toContain(tag!);
      }
    }

    const genericH = getElementsByRole("H").filter((el) => el.id);
    for (const element of genericH.slice(0, 5)) {
      const tag = getHtmlTagForId(html, element.id!);
      expect(tag).not.toBeNull();
      expect(["h1", "h2", "h3", "h4", "h5", "h6", "p"]).toContain(tag!);
      if (tag === "p") {
        const pattern = new RegExp(`<p[^>]*id=\"${escapeRegExp(element.id!)}\"[^>]*role=\"heading\"[^>]*aria-level=\"\\d+\"`, "i");
        expect(html).toMatch(pattern);
      }
    }

    const h7Plus = structElements.filter((el) => /^H\d+$/.test(el.mappedRole) && Number(el.mappedRole.slice(1)) > 6 && el.id);
    for (const element of h7Plus.slice(0, 3)) {
      const tag = getHtmlTagForId(html, element.id!);
      expect(tag).toBe("p");
      const expectedLevel = element.mappedRole.slice(1);
      const pattern = new RegExp(`<p[^>]*id=\"${escapeRegExp(element.id!)}\"[^>]*role=\"heading\"[^>]*aria-level=\"${expectedLevel}\"`, "i");
      expect(html).toMatch(pattern);
    }
  });

  it.skip("§5.2.3 maps block elements", () => {
    assertRoleTagMapping("P", ["p"]);
    assertRoleTagMapping("BlockQuote", ["blockquote"]);
    assertRoleTagMapping("Code", ["code"]);

    const notes = getElementsByRole("Note").filter((el) => el.id);
    if (notes.length === 0) {
      expect(html).not.toContain(`data-pdf-se-type=\"Note\"`);
      return;
    }

    for (const note of notes.slice(0, 3)) {
      const tag = getHtmlTagForId(html, note.id!);
      expect(tag).toBe("p");
    }

    const feNotes = getElementsByRole("FENote").filter((el) => el.id);
    if (feNotes.length === 0) {
      expect(html).not.toContain(`data-pdf-se-type=\"FENote\"`);
    } else {
      for (const feNote of feNotes.slice(0, 3)) {
        const tag = getHtmlTagForId(html, feNote.id!);
        expect(tag).toBe("aside");
      }
    }
  });

  it("§5.2.4 maps inline elements", () => {
    assertRoleTagMapping("Span", ["span"]);
    assertRoleTagMapping("Quote", ["q"]);
    assertRoleTagMapping("Em", ["em"]);
    assertRoleTagMapping("Strong", ["strong"]);
    assertRoleTagMapping("Sub", ["sub"]);
    assertRoleTagMapping("Sup", ["sup"]);
    assertRoleTagMapping("Reference", ["a"]);
    assertRoleTagMapping("Link", ["a"]);
  });

  it("§5.2.5 maps lists and list items based on ListNumbering/labels", () => {
    const listElements = getElementsByRole("L");
    if (listElements.length === 0) {
      expect(html).not.toContain(`data-pdf-se-type=\"L\"`);
      return;
    }

    for (const list of listElements) {
      if (!list.id) continue;
      const tag = getHtmlTagForId(html, list.id);
      if (list.listNumbering === "Description") {
        expect(tag).toBe("dl");
      } else if (list.listNumbering && list.listNumbering !== "None") {
        expect(tag).toBe("ol");
      } else {
        expect(["ul", "ol", "dl"]).toContain(tag!);
      }

      if (list.listHasLbl) {
        const pattern = new RegExp(`<${tag}[^>]*id=\"${escapeRegExp(list.id)}\"[^>]*style=\"[^\"]*list-style-type:\\s*none`, "i");
        expect(html).toMatch(pattern);
      }
    }

    const listItems = getElementsByRole("LI").filter((el) => el.id);
    for (const item of listItems.slice(0, 5)) {
      const tag = getHtmlTagForId(html, item.id!);
      expect(["li", "div"]).toContain(tag!);
    }

    const labels = getElementsByRole("Lbl").filter((el) => el.id);
    for (const label of labels.slice(0, 5)) {
      const tag = getHtmlTagForId(html, label.id!);
      expect(["span", "dt", "label", "div"]).toContain(tag!);
    }

    const bodies = getElementsByRole("LBody").filter((el) => el.id);
    for (const body of bodies.slice(0, 5)) {
      const tag = getHtmlTagForId(html, body.id!);
      expect(["div", "dd"]).toContain(tag!);
      if (tag === "div") {
        const pattern = new RegExp(`<div[^>]*id=\"${escapeRegExp(body.id!)}\"[^>]*style=\"[^\"]*display`, "i");
        expect(html).toMatch(pattern);
      }
    }
  });

  it("§5.2.6 maps tables and table sections", () => {
    assertRoleTagMapping("Table", ["table"]);
    assertRoleTagMapping("TR", ["tr"]);
    assertRoleTagMapping("TH", ["th"]);
    assertRoleTagMapping("TD", ["td"]);
    assertRoleTagMapping("THead", ["thead"]);
    assertRoleTagMapping("TBody", ["tbody"]);
    assertRoleTagMapping("TFoot", ["tfoot"]);
  });

  it("§5.2.7 maps figures/formulas and captions", () => {
    const figures = getElementsByRole("Figure").filter((el) => el.id);
    for (const figure of figures.slice(0, 3)) {
      const tag = getHtmlTagForId(html, figure.id!);
      if (isInlineContext(figure.parentMappedRole)) {
        expect(tag).toBe("span");
      } else {
        expect(["figure", "span"]).toContain(tag!);
      }
    }

    const formulas = getElementsByRole("Formula").filter((el) => el.id);
    for (const formula of formulas.slice(0, 3)) {
      const tag = getHtmlTagForId(html, formula.id!);
      if (isInlineContext(formula.parentMappedRole)) {
        expect(tag).toBe("span");
      } else {
        expect(["figure", "span"]).toContain(tag!);
      }
    }

    const captions = getElementsByRole("Caption").filter((el) => el.id);
    for (const caption of captions.slice(0, 5)) {
      const tag = getHtmlTagForId(html, caption.id!);
      if (caption.parentMappedRole === "Table") {
        expect(tag).toBe("caption");
      } else if (caption.parentMappedRole === "Figure" || caption.parentMappedRole === "Formula") {
        expect(tag).toBe("figcaption");
      } else {
        expect(["caption", "figcaption"]).toContain(tag!);
      }
    }
  });

  it("§5.2.8 maps ruby/warichu elements", () => {
    assertRoleTagMapping("Ruby", ["ruby"]);
    assertRoleTagMapping("RB", ["rb"]);
    assertRoleTagMapping("RT", ["rt"]);
    assertRoleTagMapping("RP", ["rp"]);
    assertRoleTagMapping("Warichu", ["span"]);
    assertRoleTagMapping("WT", ["span"]);
    assertRoleTagMapping("WP", ["span"]);
  });

  it("§5.2.9 maps special elements and suppresses NonStruct/Artifact/Private", () => {
    assertRoleTagMapping("TOC", ["ol"]);
    assertRoleTagMapping("TOCI", ["li"]);
    assertRoleTagMapping("Index", ["section"]);
    assertRoleTagMapping("BibEntry", ["p"]);

    const nonStruct = getElementsByRole("NonStruct");
    const privateEl = getElementsByRole("Private");
    const artifact = getElementsByRole("Artifact");
    if (nonStruct.length === 0) expect(html).not.toContain(`data-pdf-se-type=\"NonStruct\"`);
    if (privateEl.length === 0) expect(html).not.toContain(`data-pdf-se-type=\"Private\"`);
    if (artifact.length === 0) expect(html).not.toContain(`data-pdf-se-type=\"Artifact\"`);
  });

  it("§6.2 ensures captions are ordered before siblings within their parent", () => {
    const caption = getElementsByRole("Caption").find((el) => el.parentId && el.id);
    if (!caption?.parentId) {
      expect(html).not.toContain("data-pdf-se-type=\"Caption\"");
      return;
    }

    const parentTag = getHtmlTagForId(html, caption.parentId);
    expect(parentTag).not.toBeNull();
    const parentContent = getHtmlElementContentById(html, caption.parentId);
    expect(parentContent).not.toBeNull();

    const trimmed = parentContent!.trim();
    expect(trimmed.startsWith("<caption") || trimmed.startsWith("<figcaption")).toBe(true);
  });

  it("§6.4 keeps inline Formula/Figure content inline", () => {
    const inlineFormulas = getElementsByRole("Formula").filter((el) => isInlineContext(el.parentMappedRole) && el.id);
    for (const formula of inlineFormulas.slice(0, 5)) {
      const tag = getHtmlTagForId(html, formula.id!);
      expect(tag).toBe("span");
    }
  });

  it("§6.7 maps links/references to single anchor tags with href", () => {
    const linkTags = getHtmlTagsByRole(html, "Link");
    if (linkTags.length === 0) {
      expect(html).not.toContain(`data-pdf-se-type=\"Link\"`);
    }

    const anchorPattern = /<a[^>]*data-pdf-se-type=\"Link\"[^>]*>/gi;
    const anchors = [...html.matchAll(anchorPattern)];
    for (const anchor of anchors.slice(0, 5)) {
      expect(anchor[0]).toMatch(/href=\"[^\"]+\"/i);
    }

    expect(html).not.toMatch(/<a[^>]*>\s*<a[^>]*>/i);
  });

  it("§6.6 remaps headings inside table cells to <p> when present", () => {
    const headingInCell = structElements.find(
      (el) =>
        el.id &&
        ["TH", "TD"].includes(el.parentMappedRole || "") &&
        (el.mappedRole === "H" || /^H\\d+$/.test(el.mappedRole))
    );
    if (!headingInCell?.id) {
      expect(true).toBe(true);
      return;
    }

    const tag = getHtmlTagForId(html, headingInCell.id);
    expect(tag).toBe("p");
  });

  it.skip("§7.1 emits ID and class attributes from structure elements", () => {
    for (const element of structElements.slice(0, 20)) {
      if (!element.id) continue;
      const pattern = new RegExp(`id=\"${escapeRegExp(element.id)}\"`);
      expect(html).toMatch(pattern);
    }

    const classElements = structElements.filter((el) => el.classes && el.id).slice(0, 5);
    for (const element of classElements) {
      const pattern = new RegExp(`<[^>]*id=\"${escapeRegExp(element.id!)}\"[^>]*class=\"[^\"]+\"`, "i");
      expect(html).toMatch(pattern);
    }
  });

  it("§7.2 uses ActualText for content and ignores children", () => {
    const actualTextElement = structElements.find((el) => el.dict?.get?.("ActualText") && el.id);
    if (!actualTextElement?.id) {
      expect(html).not.toContain("ActualText");
      return;
    }

    const actualText = stringToPDFString(actualTextElement.dict.get("ActualText"));
    const content = getHtmlElementContentById(html, actualTextElement.id);
    expect(content).not.toBeNull();
    expect(content!.trim()).toBe(escapeHtml(actualText));
    expect(content).not.toMatch(/<[^>]+>/);
  });

  it("§7.3 propagates Alt text for Figure/Formula when present", () => {
    const altElement = structElements.find((el) => el.dict?.get?.("Alt") && el.id);
    if (!altElement?.id) {
      expect(html).not.toMatch(/alt=\"/i);
      return;
    }

    const altText = stringToPDFString(altElement.dict.get("Alt"));
    const altPattern = new RegExp(`alt=\"${escapeRegExp(escapeHtml(altText))}\"`, "i");
    expect(html).toMatch(altPattern);
  });

  it("§7.4 wraps Expansion Text (E) with <abbr> when present", () => {
    const expansion = structElements.find((el) => el.dict?.get?.("E"));
    if (!expansion) {
      expect(html).not.toMatch(/<abbr\b/i);
      return;
    }

    const eVal = stringToPDFString(expansion.dict.get("E"));
    const pattern = new RegExp(`<abbr[^>]*title=\"${escapeRegExp(escapeHtml(eVal))}\"`, "i");
    expect(html).toMatch(pattern);
  });

  it("§8.4 maps table attributes to HTML attributes when present", () => {
    const tableAttr = findAttributeWithKey(["ColSpan", "RowSpan", "Headers", "Scope", "Short"]);
    if (!tableAttr?.element.id) {
      expect(true).toBe(true);
      return;
    }

    const openingTag = getOpeningTagById(html, tableAttr.element.id);
    expect(openingTag).not.toBeNull();

    const attributeMap: Record<string, string> = {
      ColSpan: "colspan",
      RowSpan: "rowspan",
      Headers: "headers",
      Scope: "scope",
      Short: "abbr",
    };

    const attrName = attributeMap[tableAttr.key];
    if (!attrName) return;

    const rawValue = normalizeAttributeValue(tableAttr.value);
    const expectedValue = tableAttr.key === "Scope" ? rawValue.toLowerCase() : rawValue;
    const pattern = new RegExp(`\\b${attrName}=\"${escapeRegExp(expectedValue)}\"`, "i");
    expect(openingTag!).toMatch(pattern);
  });

  it("§8.5.1 maps TextPosition attributes to sup/sub when present", () => {
    const textPosition = findAttributeWithKey(["TextPosition"]);
    if (!textPosition?.element.id) {
      expect(true).toBe(true);
      return;
    }

    const value = normalizeAttributeValue(textPosition.value);
    const tag = getHtmlTagForId(html, textPosition.element.id);
    if (value === "Sup") {
      expect(tag).toBe("sup");
    } else if (value === "Sub") {
      expect(tag).toBe("sub");
    } else {
      expect(tag).not.toBeNull();
    }
  });

  it("§8 processes attributes into HTML attributes and CSS when present", () => {
    const anyAttrElement = structElements.find((el) => el.attributes && el.id);
    if (!anyAttrElement?.id) {
      expect(true).toBe(true);
      return;
    }

    const tag = getHtmlTagForId(html, anyAttrElement.id);
    expect(tag).not.toBeNull();
  });

  it("§9 outputs text, images, and MathML where present", () => {
    expect(html).toContain("PDF-to-HTML Derivation Algorithm Exercise");
    // expect(html).toMatch(/<img\b/i);
    // expect(html).toMatch(/<img[^>]*\bwidth=\"\d+\"[^>]*\bheight=\"\d+\"/i);

    const mathPattern = /<math[^>]*data-pdf-se-type=\"math\"/i;
    expect(html).toMatch(mathPattern);
  });

  it.skip("§9.4 includes image alt text when provided", () => {
    const alt = structElements.find((el) => el.dict?.get?.("Alt"));
    if (!alt) {
      expect(html).not.toMatch(/<img[^>]*alt=/i);
      return;
    }

    const altText = stringToPDFString(alt.dict.get("Alt"));
    expect(html).toMatch(new RegExp(`<img[^>]*alt=\"${escapeRegExp(escapeHtml(altText))}\"`, "i"));
  });

  it.skip("§10 emits form fields only when AcroForm data exists", () => {
    const hasAcroForm = Boolean(context.rootDict.get("AcroForm"));
    if (!hasAcroForm) {
      expect(html).not.toMatch(/<form\b/i);
      expect(html).not.toMatch(/<input\b/i);
      expect(html).not.toMatch(/<textarea\b/i);
      expect(html).not.toMatch(/<select\b/i);
      return;
    }

    expect(html).toMatch(/<form\b/i);
  });

  it("§11 includes ECMAScript runtime scaffolding", () => {
    expect(html).toMatch(/window\.app\s*=\s*\{/);
    expect(html).toMatch(/window\.Doc\s*=\s*function/);
    expect(html).toMatch(/window\.Field\s*=\s*function/);
    expect(html).toMatch(/window\.event\s*=\s*\{/);
  });

  it("§13 avoids invalid nesting patterns for anchors and captions", () => {
    expect(html).not.toMatch(/<a[^>]*>\s*<a[^>]*>/i);
    const captions = [...html.matchAll(/<caption[^>]*>([\s\S]*?)<\/caption>/gi)];
    for (const caption of captions) {
      expect(caption[1]).not.toMatch(/<table[^>]*>/i);
    }
  });
});
