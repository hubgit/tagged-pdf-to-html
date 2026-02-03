
import { PDFContext } from "./pdf_js_context.ts";
import { traverseStructure, StructureMap } from "./structure_traversal.ts";
import { generateCSS } from "./css_generator.ts";
import { MetadataParser } from "#pdfjs/core/metadata_parser.js";
import { processHeadAssociatedFiles } from "./associated_files.ts";
import { Dict } from "#pdfjs/core/primitives.js";
import { stringToPDFString } from "#pdfjs/shared/util.js";

/** Serialize StructureMap to JSON-compatible object */
function serializeStructureMap(structureMap: StructureMap): Record<string, { mcids: string[]; page: number }> {
    const result: Record<string, { mcids: string[]; page: number }> = {};
    for (const [elementId, mapping] of structureMap) {
        result[elementId] = { mcids: mapping.mcids, page: mapping.page };
    }
    return result;
}

export async function convertToHTML(context: PDFContext): Promise<string> {
    const { structTreeRoot, rootDict } = context;

    // 4.2.1 HTML
    // Lang
    const lang = rootDict.get("Lang");
    let htmlAttrs = "";
    if (lang) {
        // Lang can be Name or String
        const langStr = typeof lang === 'string' ? lang : (lang.name || "");
        htmlAttrs += ` lang="${escapeHtml(langStr)}"`;
    }

    // 4.2.1 Head
    let html = `<!DOCTYPE html>\n<html${htmlAttrs}>\n<head>\n`;

    // Title
    let title = "";
    // XMP Metadata
    const metadataStream = rootDict.get("Metadata");
    if (metadataStream && typeof metadataStream.getString === 'function') {
        try {
             const data = metadataStream.getString();
             if (data) {
                 const parser = new MetadataParser(data);
                 const dcTitle = parser.serializable.parsedData.get("dc:title");
                 if (dcTitle) title = dcTitle;
             }
        } catch (e) {
            console.warn("Failed to parse XMP metadata", e);
        }
    }

    if (!title) {
        title = context.filename || "PDF Document";
    }

    html += `<title>${escapeHtml(title)}</title>\n`;
    html += `<meta charset="utf-8">\n`;
    html += `<meta name="viewport" content="width=device-width, initial-scale=1">\n`;

    // 4.2.2 Associated Files in Head
    const headAF = await processHeadAssociatedFiles(context);
    if (headAF) {
        html += headAF;
    }

    // 4.2.3 ClassMap -> CSS
    const css = generateCSS(structTreeRoot);
    if (css) {
        html += `<style>\n${css}\n</style>\n`;
    }


    // 11. ECMAScript Runtime
    // Extract Document Level Scripts
    const names = rootDict.get("Names");
    let docScripts = "";
    if (names && names instanceof Dict) {
        const javascript = names.get("JavaScript");
        if (javascript && javascript instanceof Dict) {
             const jsNames = javascript.get("Names");
             if (Array.isArray(jsNames)) {
                 for (let i = 0; i < jsNames.length; i += 2) {
                     const val = jsNames[i+1];
                     const action = context.xref.fetchIfRef(val);

                     if (action instanceof Dict && action.get("S")?.name === "JavaScript") {
                         const js = action.get("JS");
                         if (js) {
                             const name = jsNames[i];
                             docScripts += `// Script: ${typeof name === 'string' ? name : 'Unnamed'}\n${stringToPDFString(js)}\n\n`;
                         }
                     }
                 }
             }
        }
    }

    // §11.2: Extract OpenAction (document open event)
    const openAction = rootDict.get("OpenAction");
    if (openAction) {
        const action = context.xref.fetchIfRef(openAction);

        if (action instanceof Dict && action.get("S")?.name === "JavaScript") {
            const js = action.get("JS");
            if (js) {
                docScripts += `// Document Open Action\n${stringToPDFString(js)}\n\n`;
            }
        }
    }

    // §11.2: Extract page-level scripts from Page/AA dictionaries
    const numPages = context.pdfDocument.numPages ?? 0;
    for (let i = 1; i <= numPages; i++) {
        try {
            const page = await context.pdfDocument.getPage(i);
            const pageDict = page.pageDict;

            if (pageDict) {
                const aa = pageDict.get("AA");
                if (aa && aa instanceof Dict) {
                    // O = Open (page becomes visible)
                    const openAct = aa.get("O");
                    if (openAct) {
                        let act = context.xref.fetchIfRef(openAct);
                        if (act instanceof Dict && act.get("S")?.name === "JavaScript") {
                            const js = act.get("JS");
                            if (js) {
                                docScripts += `// Page ${i} Open Action\n${stringToPDFString(js)}\n\n`;
                            }
                        }
                    }

                    // C = Close (page no longer visible)
                    const closeAct = aa.get("C");
                    if (closeAct) {
                        let act = context.xref.fetchIfRef(closeAct);
                        if (act instanceof Dict && act.get("S")?.name === "JavaScript") {
                            const js = act.get("JS");
                            if (js) {
                                docScripts += `// Page ${i} Close Action\n${stringToPDFString(js)}\n\n`;
                            }
                        }
                    }
                }
            }
        } catch (e: unknown) {
            const err = e as { message?: string };
            const message = err?.message ? String(err.message) : "";
            if (message.includes("Page index") && message.includes("not found")) {
                // Stop if the document reports fewer pages than numPages.
                break;
            }
            console.warn(`Failed to extract page ${i} scripts:`, e);
        }
    }

    const runtimeScript = `
    // PDF ECMAScript Runtime (§11, Annex B)
    (function() {
        console.log("PDF-HTML Runtime Initialized");

        // §11.2: app Object
        window.app = {
            viewerVersion: 1,
            viewerType: "Derivation",
            platform: "HTML",
            language: navigator.language || "en-US",

            alert: function(cMsg, nIcon, nType, cTitle, oDoc, oCheckbox) {
                window.alert(cMsg);
                return 1;
            },

            beep: function(nType) {
                console.log("Beep:", nType || 0);
            },

            response: function(cQuestion, cTitle, cDefault, bPassword, cLabel) {
                return window.prompt(cQuestion, cDefault || "");
            },

            launchURL: function(cUrl, bNewFrame) {
                if (bNewFrame) {
                    window.open(cUrl, '_blank');
                } else {
                    window.location.href = cUrl;
                }
            },

            setTimeOut: function(cExpr, nMilliseconds) {
                return setTimeout(function() { eval(cExpr); }, nMilliseconds);
            },

            clearTimeOut: function(oTime) {
                clearTimeout(oTime);
            },

            setInterval: function(cExpr, nMilliseconds) {
                return setInterval(function() { eval(cExpr); }, nMilliseconds);
            },

            clearInterval: function(oInterval) {
                clearInterval(oInterval);
            }
        };

        // §11.3: Doc Object
        window.Doc = function() {
            var self = this;

            this.numFields = 0;
            this.numPages = 1;
            this.title = document.title;

            this.getField = function(cName) {
                var elems = document.getElementsByName(cName);
                if (elems.length > 0) {
                    return new Field(elems[0]);
                }
                return null;
            };

            this.getFields = function() {
                var fields = [];
                var inputs = document.querySelectorAll("input, select, textarea, button");
                for (var i = 0; i < inputs.length; i++) {
                    if (inputs[i].name) {
                        fields.push(new Field(inputs[i]));
                    }
                }
                return fields;
            };

            this.resetForm = function(aFields) {
                var form = document.querySelector("form");
                if (form) {
                    form.reset();
                }
            };

            this.calculateNow = function() {
                // Trigger calculate events for all calculated fields
                var calcFields = document.querySelectorAll("[data-calculate]");
                for (var i = 0; i < calcFields.length; i++) {
                    var field = calcFields[i];
                    var calcExpr = field.getAttribute("data-calculate");
                    if (calcExpr) {
                        try {
                            var result = eval(calcExpr);
                            if (result !== undefined) {
                                field.value = result;
                            }
                        } catch (e) {
                            console.error("Calculate error:", e);
                        }
                    }
                }
            };

            this.print = function(bUI, nStart, nEnd, bSilent, bShrinkToFit, bPrintAsImage) {
                window.print();
            };
        };

        // §11.4: Field Object
        window.Field = function(htmlElement) {
            var self = this;
            this.element = htmlElement;
            this.name = htmlElement.name || "";
            this.type = htmlElement.type || "";

            // Properties
            Object.defineProperty(this, 'value', {
                get: function() {
                    if (self.element.type === "checkbox" || self.element.type === "radio") {
                        return self.element.checked ? "Yes" : "Off";
                    }
                    return self.element.value;
                },
                set: function(v) {
                    if (self.element.type === "checkbox" || self.element.type === "radio") {
                        self.element.checked = (v === "Yes" || v === true);
                    } else {
                        self.element.value = v;
                    }
                }
            });

            Object.defineProperty(this, 'readonly', {
                get: function() { return self.element.readOnly || self.element.disabled; },
                set: function(v) {
                    self.element.readOnly = v;
                    self.element.disabled = v;
                }
            });

            Object.defineProperty(this, 'hidden', {
                get: function() { return self.element.style.display === 'none'; },
                set: function(v) {
                    self.element.style.display = v ? 'none' : '';
                }
            });

            Object.defineProperty(this, 'display', {
                get: function() {
                    if (self.element.style.display === 'none') return 0; // hidden
                    if (self.element.readOnly) return 1; // visible, no print
                    return 2; // visible
                },
                set: function(v) {
                    if (v === 0) self.element.style.display = 'none';
                    else if (v === 1) { self.element.style.display = ''; self.element.readOnly = true; }
                    else if (v === 2) { self.element.style.display = ''; self.element.readOnly = false; }
                }
            });

            Object.defineProperty(this, 'required', {
                get: function() { return self.element.required; },
                set: function(v) { self.element.required = v; }
            });

            // Methods
            this.setFocus = function() {
                self.element.focus();
                return true;
            };

            this.setAction = function(cTrigger, cScript) {
                // Map PDF event triggers to HTML events
                var eventMap = {
                    "Keystroke": "keyup",
                    "Format": "blur",
                    "Validate": "change",
                    "Calculate": "change",
                    "MouseUp": "mouseup",
                    "MouseDown": "mousedown",
                    "MouseEnter": "mouseenter",
                    "MouseExit": "mouseleave",
                    "OnFocus": "focus",
                    "OnBlur": "blur"
                };

                var htmlEvent = eventMap[cTrigger] || cTrigger.toLowerCase();
                self.element.addEventListener(htmlEvent, function(e) {
                    try {
                        eval(cScript);
                    } catch (err) {
                        console.error("Action error:", err);
                    }
                });
            };
        };

        // §11.5: event Object
        window.event = {
            target: null,
            value: "",
            change: "",
            changeEx: "",
            type: "",
            modifier: false,
            shift: false,
            rc: true,
            willCommit: false
        };

        // Initialize Global Doc
        window.thisDoc = new window.Doc();

        // Event Handling - Setup calculate fields and event propagation
        document.addEventListener("DOMContentLoaded", function() {
            // Count fields
            var allInputs = document.querySelectorAll("input, select, textarea, button");
            window.thisDoc.numFields = allInputs.length;

            // Setup change event handlers
            for (var i = 0; i < allInputs.length; i++) {
                var input = allInputs[i];

                input.addEventListener("change", function(e) {
                    window.event.target = new Field(e.target);
                    window.event.value = e.target.value;
                    window.event.type = "change";

                    // Trigger calculate for dependent fields
                    if (window.thisDoc.calculateNow) {
                        window.thisDoc.calculateNow();
                    }
                });

                input.addEventListener("focus", function(e) {
                    window.event.target = new Field(e.target);
                    window.event.type = "focus";
                });

                input.addEventListener("blur", function(e) {
                    window.event.target = new Field(e.target);
                    window.event.type = "blur";
                });
            }
        });
    })();
    `;
    html += `<script>\n${docScripts}\n${runtimeScript}\n</script>\n`;

    html += `</head>\n`;

    // 4.2.4 Body
    html += `<body>\n`;

    // 4.3 Structure Elements
    // Note: Form fields are generated as individual controls during structure traversal
    // They function correctly without a global form wrapper (HTML5 allows standalone controls)
    const { html: bodyContent, structureMap } = await traverseStructure(context);
    html += bodyContent;

    // Embed structure map as JSON for cross-view synchronization
    // This maps structure element IDs to their associated MCIDs and page numbers
    if (structureMap.size > 0) {
        const serializedMap = serializeStructureMap(structureMap);
        html += `\n<script type="application/json" id="pdf-structure-map">\n`;
        html += JSON.stringify(serializedMap);
        html += `\n</script>\n`;
    }

    html += `</body>\n</html>`;

    return html;
}

function escapeHtml(unsafe: string): string {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}
