import { PDFContext } from "./pdf_js_context.ts";
import { createCanvas } from "#platform/canvas";
import { PDFImage } from "#pdfjs/core/image.js";
import { GlobalColorSpaceCache, LocalColorSpaceCache } from "#pdfjs/core/image_utils.js";
import { PDFFunctionFactory } from "#pdfjs/core/function.js";
import { Dict, Ref, Name } from "#pdfjs/core/primitives.js";
import type { ImageXObject } from "./types.ts";

class SimpleCache<K = unknown, V = unknown> {
    cache = new Map<K, V>();
    get(key: K) { return this.cache.get(key); }
    set(key: K, val: V) { this.cache.set(key, val); }
    clear() { this.cache.clear(); }
}

export async function convertImageXObject(context: PDFContext, imageXObject: ImageXObject | Dict, inheritedPageRef: Ref | null): Promise<string> {
    const { xref, pdfDocument } = context;

    // Get Resources from Page
    let resources = null;
    if (inheritedPageRef) {
        const page = await pdfDocument.getPage(await pdfDocument.catalog.getPageIndex(inheritedPageRef));
        resources = await page.resources;
    }

    // If no page ref, try image dict resources?
    if (!resources && !(imageXObject instanceof Dict) && imageXObject.dict) {
         resources = imageXObject.dict.get("Resources");
    }

    if (!resources) resources = context.rootDict; // Fallback

    // §9.3: Detect image format for optimal output
    const imageDict = (imageXObject instanceof Dict ? imageXObject : imageXObject.dict) as Dict | undefined;
    const filter = imageDict?.get?.("Filter") as Name | Name[] | undefined;
    const colorSpace = imageDict?.get?.("ColorSpace") as Name | unknown[] | undefined;

    // Determine if this is a photo (JPEG) or graphic (PNG)
    let isPhoto = false;
    if (filter) {
        const filterName = filter instanceof Name
            ? filter.name
            : (Array.isArray(filter) && filter[0] instanceof Name ? filter[0].name : undefined);
        // DCTDecode = JPEG encoding
        if (filterName === "DCTDecode") {
            isPhoto = true;
        }
    }

    // Also check color space - DeviceRGB photos typically use JPEG
    if (colorSpace) {
        const csName = colorSpace instanceof Name
            ? colorSpace.name
            : (Array.isArray(colorSpace) && colorSpace[0] instanceof Name ? colorSpace[0].name : undefined);
        if (csName === "DeviceRGB" && isPhoto) {
            isPhoto = true;
        }
    }

    // Helpers
    const pdfFunctionFactory = new PDFFunctionFactory({ xref });
    const globalColorSpaceCache = new SimpleCache();
    const localColorSpaceCache = new SimpleCache();

    try {
        const image = new PDFImage({
            xref,
            res: resources,
            image: imageXObject,
            isInline: false,
            pdfFunctionFactory,
            globalColorSpaceCache,
            localColorSpaceCache
        });

        // Force RGBA
        const imageData = await image.createImageData(/* forceRGBA = */ true);
        const { width, height, data } = imageData;

        if (width <= 0 || height <= 0) return "";

        // Use node-canvas
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        const canvasImageData = ctx.createImageData(width, height);

        // Copy data
        canvasImageData.data.set(data);

        ctx.putImageData(canvasImageData, 0, 0);

        // §9.3: Convert to appropriate format
        // JPEG for photos (better compression, smaller size)
        // PNG for graphics (lossless, transparency support)
        if (isPhoto) {
            return canvas.toDataURL("image/jpeg", 0.9); // 90% quality
        } else {
            return canvas.toDataURL("image/png");
        }

    } catch (e) {
        console.warn("Failed to convert image:", e);
        return "";
    }
}
