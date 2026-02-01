import { OPS } from "#pdfjs/shared/util.js";
import type { PDFPage, PDFOperator, ExtractedImage, MarkedContentProps, ImageXObject } from "./types.ts";

// Re-export types for external use
export type { ExtractedImage, MarkedContentProps };

/** Text item from text extraction */
interface TextItem {
    type?: string;
    id?: string;
    str?: string;
    hasEOL?: boolean;
}

/** Props from marked content - can be number (MCID) or object with properties */
interface MCProps {
    get?(key: string): unknown;
    MCID?: number;
}

export class ContentExtractor {
    private mcidToText: Map<number, string> = new Map();
    private mcidHasContent: Set<number> = new Set();
    private lastTextMcids: Set<number> = new Set();
    private mcidToImages: Map<number, ExtractedImage[]> = new Map();
    private mcidToOps: Map<number, PDFOperator[]> = new Map();
    private mcidToProps: Map<number, MarkedContentProps> = new Map();
    private imageDataById: Map<string, unknown> = new Map();
    private pageIndex: number;

    constructor(pageIndex: number) {
        this.pageIndex = pageIndex;
    }

    async extract(page: PDFPage) {
        // Parallel extraction
        await Promise.all([
            this.extractText(page),
            this.extractOperators(page)
        ]);
    }

    private async extractText(page: PDFPage) {
        const textContent = await page.extractTextContent({
            handler: null,
            task: {
                name: "getTextContent",
                ensureNotTerminated: () => {}
            },
            includeMarkedContent: true,
            disableNormalization: false,
            sink: {
                enqueue: (chunk: { items?: TextItem[] }) => {
                    if (chunk && chunk.items) {
                        this.processTextItems(chunk.items);
                    }
                },
                desiredSize: 1,
                ready: Promise.resolve()
            }
        });

        if (textContent && textContent.items) {
            this.processTextItems(textContent.items);
        }
    }

    private textStack: { mcids: number[] }[] = [];

    private processTextItems(items: TextItem[]) {
        for (const item of items) {
            if (item.type === "beginMarkedContentProps") {
                const mcids: number[] = [];
                if (item.id) {
                    const parts = item.id.split("_mc");
                    if (parts.length > 1) {
                        const mcid = parseInt(parts[1], 10);
                        if (!isNaN(mcid)) {
                            mcids.push(mcid);
                        }
                    }
                }
                this.textStack.push({ mcids });
            } else if (item.type === "beginMarkedContent") {
                this.textStack.push({ mcids: [] });
            } else if (item.type === "endMarkedContent") {
                this.textStack.pop();
            } else if (item.str) {
                const text = item.str;
                const isWhitespaceOnly = text.trim() === "";
                const activeMcids = new Set<number>();
                for (const entry of this.textStack) {
                    for (const mcid of entry.mcids) {
                        activeMcids.add(mcid);
                    }
                }
                if (activeMcids.size === 0) {
                    continue;
                }

                let targetMcids = activeMcids;
                if (isWhitespaceOnly) {
                    let hasActiveContent = false;
                    for (const mcid of activeMcids) {
                        if (this.mcidHasContent.has(mcid)) {
                            hasActiveContent = true;
                            break;
                        }
                    }
                    if (!hasActiveContent && this.lastTextMcids.size > 0) {
                        targetMcids = this.lastTextMcids;
                    }
                }

                for (const mcid of targetMcids) {
                    const current = this.mcidToText.get(mcid) || "";
                    let suffix = "";
                    if (item.hasEOL) suffix = "\n";
                    this.mcidToText.set(mcid, current + text + suffix);
                }

                if (!isWhitespaceOnly) {
                    for (const mcid of activeMcids) {
                        this.mcidHasContent.add(mcid);
                    }
                    this.lastTextMcids = new Set(activeMcids);
                }
            }
        }
    }

    private async extractOperators(page: PDFPage) {
        const masterFn: number[] = [];
        const masterArgs: unknown[] = [];

        const streamSink = {
            enqueue: (chunk: { fnArray?: number[]; argsArray?: unknown[] }) => {
                if (chunk.fnArray) {
                    for (const fn of chunk.fnArray) masterFn.push(fn);
                }
                if (chunk.argsArray) {
                     for (const arg of chunk.argsArray) masterArgs.push(arg);
                }
            },
            ready: Promise.resolve()
        };

        await page.getOperatorList({
            handler: {
                send: (name: string, data: unknown) => {
                    if (!Array.isArray(data)) return;
                    if (name === "obj" && data.length >= 4 && data[2] === "Image") {
                        const objId = String(data[0]);
                        this.imageDataById.set(objId, data[3]);
                    } else if (name === "commonobj" && data.length >= 3 && data[1] === "Image") {
                        const objId = String(data[0]);
                        this.imageDataById.set(objId, data[2]);
                    }
                },
                sendWithPromise: (name: string, data: unknown) => Promise.resolve()
            },
            sink: streamSink,
            task: {
                ensureNotTerminated: () => {}
            },
            intent: 0x100 // RenderingIntentFlag.OPLIST
        });

        // Loop through accumulated operators
        const fns = masterFn;
        const args = masterArgs;

        const stack: { mcids: number[] }[] = [];

        for (let i = 0; i < fns.length; i++) {
            const fn = fns[i];
            const arg = args[i] as unknown[];

            if (fn === OPS.beginMarkedContentProps) {
                // arg is [tag, props]
                const props = arg[1] as number | MCProps;
                const mcids: number[] = [];

                let mcid: number | null = null;
                if (typeof props === 'number') {
                    mcid = props;
                } else if (props && typeof props.get === 'function') {
                    mcid = props.get('MCID') as number | null;

                    // §9.7: Extract marked content properties
                    if (mcid !== null && mcid !== undefined) {
                        const contentProps: MarkedContentProps = {};

                        const lang = props.get!('Lang');
                        if (lang) contentProps.Lang = String(lang);

                        const actualText = props.get!('ActualText');
                        if (actualText) contentProps.ActualText = String(actualText);

                        const alt = props.get!('Alt');
                        if (alt) contentProps.Alt = String(alt);

                        const e = props.get!('E');
                        if (e) contentProps.E = String(e);

                        if (Object.keys(contentProps).length > 0) {
                            this.mcidToProps.set(mcid, contentProps);
                        }
                    }
                } else if (props && typeof props !== 'number' && props.MCID !== undefined) {
                    mcid = props.MCID;
                }

                if (mcid !== null && mcid !== undefined) {
                    mcids.push(mcid);
                }
                stack.push({ mcids });
            } else if (fn === OPS.beginMarkedContent) {
                stack.push({ mcids: [] });
            } else if (fn === OPS.endMarkedContent) {
                stack.pop();
            } else {
                // Record operator for all active MCIDs
                // Also check for images specifically for legacy API
                if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
                    const name = arg[0] as string;
                    const width = typeof arg[1] === "number" ? arg[1] : undefined;
                    const height = typeof arg[2] === "number" ? arg[2] : undefined;
                    this.recordImage(stack, { type: "XObject", name, width, height });
                } else if (fn === OPS.paintInlineImageXObject || fn === OPS.paintInlineImageXObjectGroup) {
                    const imgData = arg[0] as ImageXObject;
                    this.recordImage(stack, { type: "Inline", data: imgData });
                } else if (fn === OPS.paintXObject) {
                     const name = arg[0] as string;
                     this.recordImage(stack, { type: "XObject", name });
                }

                // Record generic Op
                this.recordOp(stack, fn, arg);
            }
        }
    }

    private recordImage(stack: { mcids: number[] }[], image: ExtractedImage) {
        for (const entry of stack) {
            for (const mcid of entry.mcids) {
                const images = this.mcidToImages.get(mcid) || [];
                images.push(image);
                this.mcidToImages.set(mcid, images);
            }
        }
    }

    private recordOp(stack: { mcids: number[] }[], fn: number, args: unknown[]) {
        for (const entry of stack) {
            for (const mcid of entry.mcids) {
                const ops = this.mcidToOps.get(mcid) || [];
                ops.push({ fn, args });
                this.mcidToOps.set(mcid, ops);
            }
        }
    }

    getText(mcid: number): string {
        return this.mcidToText.get(mcid) || "";
    }

    getImages(mcid: number): ExtractedImage[] {
        return this.mcidToImages.get(mcid) || [];
    }

    getOperators(mcid: number): PDFOperator[] {
        return this.mcidToOps.get(mcid) || [];
    }

    getImageData(id: string): unknown {
        return this.imageDataById.get(id);
    }

    // §9.7: Get marked content properties (Lang, ActualText, Alt, E)
    getProperties(mcid: number): MarkedContentProps | undefined {
        return this.mcidToProps.get(mcid);
    }

    hasVectorOperators(mcid: number): boolean {
        const ops = this.getOperators(mcid);
        for (const op of ops) {
            // Check for path construction/painting operators
            // OPS.moveTo (13) to OPS.endPath (28)
            // OPS.constructPath (91)
            // OPS.stroke (20), OPS.fill (22), etc.
            const fn = op.fn;
            if ((fn >= 13 && fn <= 28) || fn === 91) {
                return true;
            }
        }
        return false;
    }
}
