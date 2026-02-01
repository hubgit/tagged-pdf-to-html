import type { CanvasLike } from "./canvas.types.ts";

function getDocumentCanvas(): CanvasLike | null {
    const doc = (globalThis as unknown as { document?: { createElement?: (tag: string) => unknown } }).document;
    if (!doc || typeof doc.createElement !== "function") return null;
    const canvas = doc.createElement("canvas") as CanvasLike;
    return canvas;
}

export function createCanvas(width: number, height: number): CanvasLike {
    const canvas = getDocumentCanvas();
    if (!canvas) {
        throw new Error("Canvas is not available in this environment.");
    }
    canvas.width = width;
    canvas.height = height;
    return canvas;
}
