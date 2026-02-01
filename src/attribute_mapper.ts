import { Name, Dict } from "#pdfjs/core/primitives.js";
import type { PDFAttributes, PDFColor } from "./types.ts";

// Process attributes with priority ordering: List → Table → Layout → HTML → CSS → ARIA (§7.1)
// Later attributes override earlier ones for the same property
export function getHTMLAttributes(attributes: PDFAttributes): string {
    if (!attributes) return "";

    // Attributes can be a Dict or Array of Dicts
    const attrList = Array.isArray(attributes) ? attributes : [attributes];

    // Separate attributes by owner type for priority processing
    const listAttrs: Dict[] = [];
    const tableAttrs: Dict[] = [];
    const layoutAttrs: Dict[] = [];
    const htmlAttrs: Dict[] = [];
    const cssAttrs: Dict[] = [];
    const ariaAttrs: Dict[] = [];
    const unknownAttrs: Dict[] = [];

    for (const attrDict of attrList) {
        if (!attrDict || !(attrDict instanceof Dict)) continue;
        const owner = attrDict.get("O")?.name;

        if (owner === "List") listAttrs.push(attrDict);
        else if (owner === "Table") tableAttrs.push(attrDict);
        else if (owner === "Layout") layoutAttrs.push(attrDict);
        else if (owner?.startsWith("HTML")) htmlAttrs.push(attrDict);
        else if (owner?.startsWith("CSS")) cssAttrs.push(attrDict);
        else if (owner === "ARIA" || owner?.startsWith("ARIA")) ariaAttrs.push(attrDict);
        else unknownAttrs.push(attrDict); // Process unknown as Table for backwards compat
    }

    // Map to store final attribute values (later overrides earlier)
    const attrMap = new Map<string, string>();

    // Process in priority order: List → Table → Layout → HTML → CSS → ARIA
    processListAttributes(listAttrs, attrMap);
    processTableAttributes([...tableAttrs, ...unknownAttrs], attrMap); // Unknown treated as Table
    processLayoutAttributesForHTML(layoutAttrs, attrMap);
    processHTMLAttributes(htmlAttrs, attrMap);
    processCSSAttributesForHTML(cssAttrs, attrMap);
    processARIAAttributes(ariaAttrs, attrMap);

    // Convert map to HTML attribute string
    let attrs = "";
    for (const [key, value] of attrMap) {
        attrs += ` ${key}="${value}"`;
    }
    return attrs;
}

function processListAttributes(attrList: Dict[], attrMap: Map<string, string>) {
    for (const attrDict of attrList) {
        // ListNumbering is handled elsewhere, but could add data attributes if needed
        const listNumbering = (attrDict.get("ListNumbering") as Name | undefined)?.name;
        if (listNumbering) {
            attrMap.set("data-list-numbering", listNumbering.toLowerCase());
        }
    }
}

function processTableAttributes(attrList: Dict[], attrMap: Map<string, string>) {
    for (const attrDict of attrList) {
        const colSpan = attrDict.get("ColSpan") as number | undefined;
        if (colSpan) attrMap.set("colspan", String(colSpan));

        const rowSpan = attrDict.get("RowSpan") as number | undefined;
        if (rowSpan) attrMap.set("rowspan", String(rowSpan));

        const headers = attrDict.get("Headers") as string | string[] | undefined;
        if (headers) {
            const headersStr = Array.isArray(headers) ? headers.join(" ") : String(headers);
            attrMap.set("headers", headersStr);
        }

        const scope = (attrDict.get("Scope") as Name | undefined)?.name;
        if (scope) attrMap.set("scope", scope.toLowerCase());

        const short = attrDict.get("Short") as string | undefined;
        if (short) attrMap.set("abbr", String(short));

        const summary = attrDict.get("Summary") as string | undefined;
        if (summary) attrMap.set("abbr", String(summary));
    }
}

function processLayoutAttributesForHTML(attrList: Dict[], attrMap: Map<string, string>) {
    // Layout attributes typically map to CSS, but some can affect HTML attributes
    // Most layout attributes are processed in getCSSProperties
    for (const attrDict of attrList) {
        // Add data attributes for layout properties if needed
        const placement = (attrDict.get("Placement") as Name | undefined)?.name;
        if (placement) {
            attrMap.set("data-placement", placement.toLowerCase());
        }
    }
}

function processHTMLAttributes(attrList: Dict[], attrMap: Map<string, string>) {
    // HTML-specific attributes (depends on HTML version in owner)
    for (const attrDict of attrList) {
        // Process standard HTML attributes here
        // This would include attributes like maxlength, pattern, etc.
        // For now, pass through as data attributes
        for (const key of attrDict.getKeys()) {
            if (key !== "O") {
                const value = attrDict.get(key);
                if (value !== undefined && value !== null) {
                    attrMap.set(`data-html-${key.toLowerCase()}`, String(value));
                }
            }
        }
    }
}

function processCSSAttributesForHTML(attrList: Dict[], attrMap: Map<string, string>) {
    // CSS attributes are typically processed in getCSSProperties
    // But we can add class references if specified
    for (const attrDict of attrList) {
        // CSS attributes typically don't map to HTML attributes directly
        // They're handled in style attribute via getCSSProperties
    }
}

function processARIAAttributes(attrList: Dict[], attrMap: Map<string, string>) {
    for (const attrDict of attrList) {
        // Process ARIA attributes
        for (const key of attrDict.getKeys()) {
            if (key !== "O") {
                const value = attrDict.get(key);
                if (value !== undefined && value !== null) {
                    // Convert to aria- prefix
                    const ariaKey = key.startsWith("aria-") ? key : `aria-${key.toLowerCase()}`;
                    attrMap.set(ariaKey, String(value));
                }
            }
        }
    }
}

export function getBBox(attributes: PDFAttributes): number[] | null {
    if (!attributes) return null;
    const attrList = Array.isArray(attributes) ? attributes : [attributes];
    for (const attrDict of attrList) {
        if (!attrDict || !(attrDict instanceof Dict)) continue;
        const bbox = attrDict.get("BBox") as number[] | undefined;
        if (Array.isArray(bbox) && bbox.length === 4) {
            return bbox;
        }
    }
    return null;
}

export function getCSSProperties(attributes: PDFAttributes): string {
    if (!attributes) return "";

    const attrList = Array.isArray(attributes) ? attributes : [attributes];

    // Separate attributes by owner type for priority processing
    const listAttrs: Dict[] = [];
    const tableAttrs: Dict[] = [];
    const layoutAttrs: Dict[] = [];
    const cssAttrs: Dict[] = [];
    const unknownAttrs: Dict[] = [];

    for (const attrDict of attrList) {
        if (!attrDict || !(attrDict instanceof Dict)) continue;
        const owner = attrDict.get("O")?.name;

        if (owner === "List") listAttrs.push(attrDict);
        else if (owner === "Table") tableAttrs.push(attrDict);
        else if (owner === "Layout") layoutAttrs.push(attrDict);
        else if (owner?.startsWith("CSS")) cssAttrs.push(attrDict);
        else unknownAttrs.push(attrDict);
    }

    // Map to store final CSS properties (later overrides earlier)
    const cssMap = new Map<string, string>();

    // Process in priority order: List → Table → Layout → CSS
    processCSSFromList(listAttrs, cssMap);
    processCSSFromTable([...tableAttrs, ...unknownAttrs], cssMap);
    processCSSFromLayout(layoutAttrs, cssMap);
    processCSSFromCSS(cssAttrs, cssMap);

    // Convert map to CSS string
    let css = "";
    for (const [property, value] of cssMap) {
        css += `${property}: ${value}; `;
    }
    return css;
}

function processCSSFromList(attrList: Dict[], cssMap: Map<string, string>) {
    // §8.3 Table 1: List attributes that affect CSS
    for (const attrDict of attrList) {
        // StartIndent → margin-left for list items
        const startIndent = attrDict.get("StartIndent") as number | undefined;
        if (startIndent !== undefined) {
            cssMap.set("margin-left", `${startIndent}px`);
        }

        // ListNumbering might affect list-style-type
        const listNumbering = (attrDict.get("ListNumbering") as Name | undefined)?.name;
        if (listNumbering) {
            if (listNumbering === "Disc") {
                cssMap.set("list-style-type", "disc");
            } else if (listNumbering === "Circle") {
                cssMap.set("list-style-type", "circle");
            } else if (listNumbering === "Square") {
                cssMap.set("list-style-type", "square");
            } else if (listNumbering === "Decimal") {
                cssMap.set("list-style-type", "decimal");
            } else if (listNumbering === "UpperRoman") {
                cssMap.set("list-style-type", "upper-roman");
            } else if (listNumbering === "LowerRoman") {
                cssMap.set("list-style-type", "lower-roman");
            } else if (listNumbering === "UpperAlpha") {
                cssMap.set("list-style-type", "upper-alpha");
            } else if (listNumbering === "LowerAlpha") {
                cssMap.set("list-style-type", "lower-alpha");
            }
        }
    }
}

function processCSSFromTable(attrList: Dict[], cssMap: Map<string, string>) {
    // Table attributes that affect CSS (minimal)
    for (const attrDict of attrList) {
        // Most table attributes are HTML attributes, not CSS
    }
}

function processCSSFromLayout(attrList: Dict[], cssMap: Map<string, string>) {
    for (const attrDict of attrList) {
        processLayoutCSSProperties(attrDict, cssMap);
    }
}

function processCSSFromCSS(attrList: Dict[], cssMap: Map<string, string>) {
    for (const attrDict of attrList) {
        // CSS attributes - process all CSS properties
        processLayoutCSSProperties(attrDict, cssMap);
    }
}

function processLayoutCSSProperties(attrDict: Dict, cssMap: Map<string, string>) {
    // Layout (Table 4) & CSS attributes

    // BackgroundColor
    const bgColor = attrDict.get("BackgroundColor") as PDFColor | undefined;
    if (bgColor) cssMap.set("background-color", parseColor(bgColor));

    // BorderColor
    const borderColor = attrDict.get("BorderColor") as PDFColor | undefined;
    if (borderColor) cssMap.set("border-color", parseColor(borderColor));

    // BorderStyle
    const borderStyle = attrDict.get("BorderStyle") || attrDict.get("TBorderStyle");
    if (borderStyle) {
        const style = borderStyle instanceof Name ? borderStyle.name : String(borderStyle);
        cssMap.set("border-style", style.toLowerCase());
    }

    // BorderThickness
    const borderThickness = attrDict.get("BorderThickness") as number | undefined;
    if (borderThickness !== undefined) cssMap.set("border-width", `${borderThickness}px`);

    // Color
    const color = attrDict.get("Color") as PDFColor | undefined;
    if (color) cssMap.set("color", parseColor(color));

    // Padding / TPadding
    const padding = (attrDict.get("Padding") || attrDict.get("TPadding")) as number | undefined;
    if (padding !== undefined) cssMap.set("padding", `${padding}px`);

    // TextAlign
    const textAlign = (attrDict.get("TextAlign") as Name | undefined)?.name;
    if (textAlign) cssMap.set("text-align", textAlign.toLowerCase());

    // TextIndent
    const textIndent = attrDict.get("TextIndent") as number | undefined;
    if (textIndent !== undefined) cssMap.set("text-indent", `${textIndent}px`);

    // LineHeight
    const lineHeight = attrDict.get("LineHeight") as Name | number | undefined;
    if (lineHeight) {
        const val = lineHeight instanceof Name ? lineHeight.name : lineHeight;
        const cssVal = typeof val === "number" ? `${val}pt` : String(val);
        cssMap.set("line-height", cssVal);
    }

    // SpaceBefore -> margin-top
    const spaceBefore = attrDict.get("SpaceBefore") as number | undefined;
    if (spaceBefore !== undefined) {
        cssMap.set("display", "block");
        cssMap.set("margin-top", `${spaceBefore}px`);
    }

    // SpaceAfter -> margin-bottom
    const spaceAfter = attrDict.get("SpaceAfter") as number | undefined;
    if (spaceAfter !== undefined) {
        cssMap.set("display", "block");
        cssMap.set("margin-bottom", `${spaceAfter}px`);
    }

    // StartIndent -> margin-left
    const startIndent = attrDict.get("StartIndent") as number | undefined;
    if (startIndent !== undefined) {
        cssMap.set("display", "block");
        cssMap.set("margin-left", `${startIndent}px`);
    }

    // EndIndent -> margin-right
    const endIndent = attrDict.get("EndIndent") as number | undefined;
    if (endIndent !== undefined) {
        cssMap.set("display", "block");
        cssMap.set("margin-right", `${endIndent}px`);
    }

    // Width / Height (BBox)
    const bbox = attrDict.get("BBox") as number[] | undefined;
    if (Array.isArray(bbox) && bbox.length === 4) {
        const width = bbox[2] - bbox[0];
        const height = bbox[3] - bbox[1];
        cssMap.set("width", `${width}px`);
        cssMap.set("height", `${height}px`);
    }

    const width = attrDict.get("Width") as number | undefined;
    if (width !== undefined) cssMap.set("width", `${width}px`);

    const height = attrDict.get("Height") as number | undefined;
    if (height !== undefined) cssMap.set("height", `${height}px`);

    // Placement
    const placement = (attrDict.get("Placement") as Name | undefined)?.name;
    if (placement) {
        if (placement === "Block") {
            cssMap.set("display", "block");
        } else if (placement === "Inline") {
            cssMap.set("display", "inline");
        } else if (placement === "Before") {
            cssMap.set("float", "left");
            cssMap.set("clear", "both");
        } else if (placement === "Start") {
            cssMap.set("float", "left");
        } else if (placement === "End") {
            cssMap.set("float", "right");
        }
    }

    // WritingMode
    const writingMode = (attrDict.get("WritingMode") as Name | undefined)?.name;
    if (writingMode) {
        if (writingMode === "TbRl") cssMap.set("writing-mode", "vertical-rl");
        else if (writingMode === "LrTb" || writingMode === "RlTb") cssMap.set("writing-mode", "horizontal-tb");
    }

    // BaselineShift
    const baselineShift = attrDict.get("BaselineShift") as number | undefined;
    if (baselineShift !== undefined) {
        cssMap.set("vertical-align", `${baselineShift}px`);
    }

    // TextDecoration
    const textDecoType = (attrDict.get("TextDecorationType") as Name | undefined)?.name;
    if (textDecoType) {
        if (textDecoType === "Underline") cssMap.set("text-decoration", "underline");
        else if (textDecoType === "LineThrough") cssMap.set("text-decoration", "line-through");
        else if (textDecoType === "Overline") cssMap.set("text-decoration", "overline");
        else if (textDecoType === "None") cssMap.set("text-decoration", "none");
    }

    // TextDecorationColor
    const textDecoColor = attrDict.get("TextDecorationColor") as PDFColor | undefined;
    if (textDecoColor) {
        cssMap.set("text-decoration-color", parseColor(textDecoColor));
    }

    // RubyAlign
    const rubyAlign = (attrDict.get("RubyAlign") as Name | undefined)?.name;
    if (rubyAlign) {
        let val = "auto";
        if (rubyAlign === "Start") val = "start";
        else if (rubyAlign === "Center") val = "center";
        else if (rubyAlign === "End") val = "end";
        else if (rubyAlign === "Justify") val = "space-between";
        else if (rubyAlign === "Distribute") val = "space-around";

        cssMap.set("ruby-align", val);
    }

    // RubyPosition
    const rubyPosition = (attrDict.get("RubyPosition") as Name | undefined)?.name;
    if (rubyPosition) {
        let val = "";
        if (rubyPosition === "Before") val = "over";
        else if (rubyPosition === "After") val = "under";

        if (val) cssMap.set("ruby-position", val);
    }
}

function parseColor(colorObj: PDFColor): string {
    if (!Array.isArray(colorObj)) {
        return "inherit";
    }
    if (colorObj.length === 1) {
        // Gray
        const g = Math.round(colorObj[0] * 255);
        return `rgb(${g}, ${g}, ${g})`;
    } else if (colorObj.length === 3) {
        // RGB
        const r = Math.round(colorObj[0] * 255);
        const g = Math.round(colorObj[1] * 255);
        const b = Math.round(colorObj[2] * 255);
        return `rgb(${r}, ${g}, ${b})`;
    } else if (colorObj.length === 4) {
        // CMYK - Simple approximation
        const c = colorObj[0];
        const m = colorObj[1];
        const y = colorObj[2];
        const k = colorObj[3];

        const r = Math.round(255 * (1 - c) * (1 - k));
        const g = Math.round(255 * (1 - m) * (1 - k));
        const b = Math.round(255 * (1 - y) * (1 - k));
        return `rgb(${r}, ${g}, ${b})`;
    }
    return "inherit";
}
