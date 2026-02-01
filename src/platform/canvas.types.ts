export type CanvasContextLike = {
    createImageData(width: number, height: number): { data: Uint8ClampedArray; width: number; height: number };
    putImageData(imageData: { data: Uint8ClampedArray }, dx: number, dy: number): void;
    fillStyle: string;
    strokeStyle: string;
    font: string;
    textAlign: string;
    textBaseline: string;
    fillRect(x: number, y: number, w: number, h: number): void;
    strokeRect(x: number, y: number, w: number, h: number): void;
    fillText(text: string, x: number, y: number): void;
    drawImage(image: unknown, dx: number, dy: number): void;
};

export type CanvasLike = {
    width: number;
    height: number;
    getContext(type: "2d"): CanvasContextLike | null;
    toDataURL(type?: string, quality?: number): string;
};
