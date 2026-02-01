import { createCanvas as createCanvasNode } from "@napi-rs/canvas";
import type { CanvasLike } from "./canvas.types.ts";

export function createCanvas(width: number, height: number): CanvasLike {
    return createCanvasNode(width, height) as unknown as CanvasLike;
}
