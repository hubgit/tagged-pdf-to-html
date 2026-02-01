// §9.3: Vector Graphics Rendering - Convert PDF path operations to SVG
import { OPS, DrawOPS } from "#pdfjs/shared/util.js";

export interface SVGRenderOptions {
    width: number;
    height: number;
    viewBox?: number[];
    useContentBox?: boolean;
}

export function generateSVG(operators: { fn: number; args: any[] }[], options: SVGRenderOptions): string {
    const { width, height, viewBox, useContentBox } = options;
    const paths: string[] = [];

    // Graphics state
    let currentPath = "";
    let currentX = 0;
    let currentY = 0;
    let fillColor = "black";
    let strokeColor = "black";
    let lineWidth = 1;
    let fillRule = "nonzero";

    // Transformation matrix [a, b, c, d, e, f]
    let ctm = [1, 0, 0, 1, 0, 0];
    const ctmStack: number[][] = [];

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const op of operators) {
        const fn = op.fn;
        const args = op.args;

        switch (fn) {
            case OPS.constructPath: {
                const [opCode, data] = args;
                const pathData = Array.isArray(data) ? data[0] : null;
                if (!pathData) break;

                const { d, bounds } = buildPathFromDrawOps(pathData, ctm);
                if (!d) break;
                if (bounds) {
                    if (bounds.minX < minX) minX = bounds.minX;
                    if (bounds.minY < minY) minY = bounds.minY;
                    if (bounds.maxX > maxX) maxX = bounds.maxX;
                    if (bounds.maxY > maxY) maxY = bounds.maxY;
                }

                const isEvenOdd = opCode === OPS.eoFill || opCode === OPS.eoFillStroke || opCode === OPS.closeEOFillStroke;
                const doFill =
                    opCode === OPS.fill ||
                    opCode === OPS.eoFill ||
                    opCode === OPS.fillStroke ||
                    opCode === OPS.eoFillStroke ||
                    opCode === OPS.closeFillStroke ||
                    opCode === OPS.closeEOFillStroke;
                const doStroke =
                    opCode === OPS.stroke ||
                    opCode === OPS.closeStroke ||
                    opCode === OPS.fillStroke ||
                    opCode === OPS.eoFillStroke ||
                    opCode === OPS.closeFillStroke ||
                    opCode === OPS.closeEOFillStroke;

                const fill = doFill ? fillColor : "none";
                const stroke = doStroke ? strokeColor : "none";
                const rule = isEvenOdd ? "evenodd" : "nonzero";

                paths.push(`<path d="${d.trim()}" fill="${fill}" stroke="${stroke}" stroke-width="${lineWidth}" fill-rule="${rule}" />`);
                break;
            }

            // Path construction
            case OPS.moveTo: // m
                if (args.length >= 2) {
                    const [x, y] = transformPoint(args[0], args[1], ctm);
                    currentPath += `M ${x} ${y} `;
                    currentX = x;
                    currentY = y;
                }
                break;

            case OPS.lineTo: // l
                if (args.length >= 2) {
                    const [x, y] = transformPoint(args[0], args[1], ctm);
                    currentPath += `L ${x} ${y} `;
                    currentX = x;
                    currentY = y;
                }
                break;

            case OPS.curveTo: // c (Bézier curve)
                if (args.length >= 6) {
                    const [x1, y1] = transformPoint(args[0], args[1], ctm);
                    const [x2, y2] = transformPoint(args[2], args[3], ctm);
                    const [x3, y3] = transformPoint(args[4], args[5], ctm);
                    currentPath += `C ${x1} ${y1} ${x2} ${y2} ${x3} ${y3} `;
                    currentX = x3;
                    currentY = y3;
                }
                break;

            case OPS.curveTo2: // v (Bézier curve with first control point = current point)
                if (args.length >= 4) {
                    const [x2, y2] = transformPoint(args[0], args[1], ctm);
                    const [x3, y3] = transformPoint(args[2], args[3], ctm);
                    currentPath += `C ${currentX} ${currentY} ${x2} ${y2} ${x3} ${y3} `;
                    currentX = x3;
                    currentY = y3;
                }
                break;

            case OPS.curveTo3: // y (Bézier curve with second control point = end point)
                if (args.length >= 4) {
                    const [x1, y1] = transformPoint(args[0], args[1], ctm);
                    const [x3, y3] = transformPoint(args[2], args[3], ctm);
                    currentPath += `C ${x1} ${y1} ${x3} ${y3} ${x3} ${y3} `;
                    currentX = x3;
                    currentY = y3;
                }
                break;

            case OPS.closePath: // h
                currentPath += "Z ";
                break;

            case OPS.rectangle: // re
                if (args.length >= 4) {
                    const [x, y] = transformPoint(args[0], args[1], ctm);
                    const w = args[2] * ctm[0]; // Scale width
                    const h = args[3] * ctm[3]; // Scale height
                    currentPath += `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z `;
                }
                break;

            // Path painting
            case OPS.fill: // f, F
            case OPS.eoFill: // f*
                if (currentPath) {
                    const fill = fn === OPS.eoFill ? "evenodd" : "nonzero";
                    svg += `<path d="${currentPath.trim()}" fill="${fillColor}" fill-rule="${fill}" />`;
                    currentPath = "";
                }
                break;

            case OPS.stroke: // S
                if (currentPath) {
                    svg += `<path d="${currentPath.trim()}" fill="none" stroke="${strokeColor}" stroke-width="${lineWidth}" />`;
                    currentPath = "";
                }
                break;

            case OPS.fillStroke: // B
            case OPS.eoFillStroke: // B*
                if (currentPath) {
                    const fill = fn === OPS.eoFillStroke ? "evenodd" : "nonzero";
                    svg += `<path d="${currentPath.trim()}" fill="${fillColor}" fill-rule="${fill}" stroke="${strokeColor}" stroke-width="${lineWidth}" />`;
                    currentPath = "";
                }
                break;

            case OPS.closeFillStroke: // b
            case OPS.closeEOFillStroke: // b*
                currentPath += "Z ";
                if (currentPath) {
                    const fill = fn === OPS.closeEOFillStroke ? "evenodd" : "nonzero";
                    svg += `<path d="${currentPath.trim()}" fill="${fillColor}" fill-rule="${fill}" stroke="${strokeColor}" stroke-width="${lineWidth}" />`;
                    currentPath = "";
                }
                break;

            case OPS.closeStroke: // s
                currentPath += "Z ";
                if (currentPath) {
                    svg += `<path d="${currentPath.trim()}" fill="none" stroke="${strokeColor}" stroke-width="${lineWidth}" />`;
                    currentPath = "";
                }
                break;

            case OPS.endPath: // n
                currentPath = "";
                break;

            // Color operators
            case OPS.setFillRGBColor: // rg
                if (args.length >= 3) {
                    fillColor = rgbToHex(args[0], args[1], args[2]);
                }
                break;

            case OPS.setStrokeRGBColor: // RG
                if (args.length >= 3) {
                    strokeColor = rgbToHex(args[0], args[1], args[2]);
                }
                break;

            case OPS.setFillGray: // g
                if (args.length >= 1) {
                    const gray = Math.round(args[0] * 255);
                    fillColor = `rgb(${gray},${gray},${gray})`;
                }
                break;

            case OPS.setStrokeGray: // G
                if (args.length >= 1) {
                    const gray = Math.round(args[0] * 255);
                    strokeColor = `rgb(${gray},${gray},${gray})`;
                }
                break;

            case OPS.setFillCMYKColor: // k
                if (args.length >= 4) {
                    fillColor = cmykToHex(args[0], args[1], args[2], args[3]);
                }
                break;

            case OPS.setStrokeCMYKColor: // K
                if (args.length >= 4) {
                    strokeColor = cmykToHex(args[0], args[1], args[2], args[3]);
                }
                break;

            // Line width
            case OPS.setLineWidth: // w
                if (args.length >= 1) {
                    lineWidth = args[0];
                }
                break;

            // Graphics state save/restore
            case OPS.save: // q
                ctmStack.push([...ctm]);
                break;

            case OPS.restore: // Q
                if (ctmStack.length > 0) {
                    ctm = ctmStack.pop()!;
                }
                break;

            case OPS.transform: // cm
                if (args.length >= 6) {
                    // Multiply current matrix by new matrix
                    ctm = multiplyMatrices(ctm, args);
                }
                break;

            // Ignore text and image operators in vector rendering
            case OPS.showText:
            case OPS.showSpacedText:
            case OPS.paintImageXObject:
            case OPS.paintInlineImageXObject:
                // Skip - these are handled separately
                break;
        }
    }

    let vbX = 0;
    let vbY = 0;
    let vbW = width;
    let vbH = height;

    if (useContentBox && Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) {
        vbX = minX;
        vbY = minY;
        vbW = Math.max(0, maxX - minX);
        vbH = Math.max(0, maxY - minY);
    } else if (viewBox && viewBox.length >= 4) {
        [vbX, vbY, vbW, vbH] = viewBox;
    }

    return `<svg width="${width}" height="${height}" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg">${paths.join("")}</svg>`;
}

function buildPathFromDrawOps(
    data: Float32Array | number[],
    matrix: number[]
): { d: string; bounds: { minX: number; minY: number; maxX: number; maxY: number } | null } {
    let d = "";
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    if (!data || data.length === 0) {
        return { d: "", bounds: null };
    }

    let i = 0;
    while (i < data.length) {
        const op = data[i++];
        switch (op) {
            case DrawOPS.moveTo: {
                const x = data[i++];
                const y = data[i++];
                const [tx, ty] = transformPoint(x, y, matrix);
                d += `M ${tx} ${ty} `;
                if (tx < minX) minX = tx;
                if (ty < minY) minY = ty;
                if (tx > maxX) maxX = tx;
                if (ty > maxY) maxY = ty;
                break;
            }
            case DrawOPS.lineTo: {
                const x = data[i++];
                const y = data[i++];
                const [tx, ty] = transformPoint(x, y, matrix);
                d += `L ${tx} ${ty} `;
                if (tx < minX) minX = tx;
                if (ty < minY) minY = ty;
                if (tx > maxX) maxX = tx;
                if (ty > maxY) maxY = ty;
                break;
            }
            case DrawOPS.curveTo: {
                const x1 = data[i++];
                const y1 = data[i++];
                const x2 = data[i++];
                const y2 = data[i++];
                const x3 = data[i++];
                const y3 = data[i++];
                const [tx1, ty1] = transformPoint(x1, y1, matrix);
                const [tx2, ty2] = transformPoint(x2, y2, matrix);
                const [tx3, ty3] = transformPoint(x3, y3, matrix);
                d += `C ${tx1} ${ty1} ${tx2} ${ty2} ${tx3} ${ty3} `;
                minX = Math.min(minX, tx1, tx2, tx3);
                minY = Math.min(minY, ty1, ty2, ty3);
                maxX = Math.max(maxX, tx1, tx2, tx3);
                maxY = Math.max(maxY, ty1, ty2, ty3);
                break;
            }
            case DrawOPS.quadraticCurveTo: {
                const x1 = data[i++];
                const y1 = data[i++];
                const x2 = data[i++];
                const y2 = data[i++];
                const [tx1, ty1] = transformPoint(x1, y1, matrix);
                const [tx2, ty2] = transformPoint(x2, y2, matrix);
                d += `Q ${tx1} ${ty1} ${tx2} ${ty2} `;
                minX = Math.min(minX, tx1, tx2);
                minY = Math.min(minY, ty1, ty2);
                maxX = Math.max(maxX, tx1, tx2);
                maxY = Math.max(maxY, ty1, ty2);
                break;
            }
            case DrawOPS.closePath:
                d += "Z ";
                break;
            default:
                // Skip unknown op
                break;
        }
    }

    const hasBounds = Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY);
    return {
        d,
        bounds: hasBounds ? { minX, minY, maxX, maxY } : null
    };
}

function transformPoint(x: number, y: number, matrix: number[]): [number, number] {
    const [a, b, c, d, e, f] = matrix;
    return [
        a * x + c * y + e,
        b * x + d * y + f
    ];
}

function multiplyMatrices(m1: number[], m2: number[]): number[] {
    const [a1, b1, c1, d1, e1, f1] = m1;
    const [a2, b2, c2, d2, e2, f2] = m2;

    return [
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2
    ];
}

function rgbToHex(r: number, g: number, b: number): string {
    const toHex = (n: number) => {
        const clamped = Math.max(0, Math.min(1, n));
        const value = Math.round(clamped * 255);
        return value.toString(16).padStart(2, '0');
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function cmykToHex(c: number, m: number, y: number, k: number): string {
    // Convert CMYK to RGB
    const r = 1 - Math.min(1, c * (1 - k) + k);
    const g = 1 - Math.min(1, m * (1 - k) + k);
    const b = 1 - Math.min(1, y * (1 - k) + k);
    return rgbToHex(r, g, b);
}
