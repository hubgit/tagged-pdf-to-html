import { getCSSProperties } from "./attribute_mapper.ts";
import type { StructTreeRootType } from "./types.ts";

export function generateCSS(structTreeRoot: StructTreeRootType | null): string {
    if (!structTreeRoot) return "";

    const classMap = structTreeRoot.dict.get("ClassMap");
    if (!classMap) return "";

    let css = "";
    // classMap is a Dict
    for (const key of classMap.getKeys()) {
        const attributes = classMap.get(key);
        css += `.${key} { `;
        css += getCSSProperties(attributes);
        css += " }\n";
    }
    return css;
}
