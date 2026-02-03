import { deriveHtmlFromPdf } from "../src/index.ts";
import { getDocument } from "pdfjs/display/api.js";
import { GlobalWorkerOptions } from "pdfjs/display/worker_options.js";
import { TextLayer } from "pdfjs/display/text_layer.js";
import { setLayerDimensions } from "pdfjs/display/display_utils.js";
import PdfWorker from "pdfjs/pdf.worker.js?worker";

const statusEl = document.getElementById("status");
const pdfIntro = document.getElementById("pdf-intro");
const pdfPane = document.getElementById("pdf-pane");
const htmlFrame = document.getElementById("html-frame");
const pdfInput = document.getElementById("pdf-input");
const structTreeEl = document.getElementById("struct-tree");
const pdfPagesEl = document.getElementById("pdf-pages");

let pdfWorker = null;
let pdfDoc = null;
let activeHighlights = [];
let activeSummary = null;
let structNodeCounter = 0;
const structNodeMap = new Map();
const structNodeContentIds = new Map();
const structNodeInfo = new Map();
let pageEntries = [];
let activePageIndex = 0;
let activeTextLayerEl = null;
let currentScale = 1;
let activeHtmlHighlights = [];
const HTML_HIGHLIGHT_CLASS = "tag-highlight-html";

// Structure map from HTML output: elementId -> { mcids: string[], page: number }
let htmlStructureMap = null;
// Reverse map: mcid -> elementId
let mcidToElementMap = new Map();

function setStatus(message) {
  statusEl.textContent = message;
}

function showPdfIntro() {
  pdfIntro?.classList.remove("is-hidden");
  pdfPane?.classList.add("is-hidden");
  clearPdfLayer();
  resetStructTree("");
}

function showPdfPane() {
  pdfIntro?.classList.add("is-hidden");
  pdfPane?.classList.remove("is-hidden");
}

function ensureWorker() {
  if (pdfWorker) {
    return;
  }
  pdfWorker = new PdfWorker();
  GlobalWorkerOptions.workerPort = pdfWorker;
}

function clearPdfLayer() {
  if (pdfPagesEl) {
    pdfPagesEl.innerHTML = "";
  }
  pageEntries = [];
  activePageIndex = 0;
  activeTextLayerEl = null;
}

function resetStructTree(message) {
  structNodeCounter = 0;
  structNodeMap.clear();
  structNodeContentIds.clear();
  structNodeInfo.clear();
  if (structTreeEl) {
    structTreeEl.textContent = message;
  }
  clearTreeSelection();
}

function clearTreeSelection() {
  activeSummary?.classList.remove("is-selected");
  activeSummary = null;
  clearHighlights();
  clearHtmlHighlights();
}

function clearHighlights() {
  for (const el of activeHighlights) {
    el.classList.remove("tag-highlight");
  }
  activeHighlights = [];
}

function clearHtmlHighlights() {
  for (const el of activeHtmlHighlights) {
    el.classList.remove(HTML_HIGHLIGHT_CLASS);
  }
  activeHtmlHighlights = [];
}

function escapeCssId(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function ensureHtmlHighlightStyle(doc) {
  if (!doc || doc.getElementById("html-highlight-style")) {
    return;
  }
  const style = doc.createElement("style");
  style.id = "html-highlight-style";
  style.textContent = `
    .${HTML_HIGHLIGHT_CLASS} {
      outline: 2px solid #f59f00;
      background: rgba(255, 214, 102, 0.35);
      scroll-margin: 80px;
    }
    [id^="pdf-se-"], [id^="widget_"] {
      cursor: pointer;
    }
  `;
  doc.head?.append(style);
}

function loadStructureMapFromHtml() {
  if (!htmlFrame?.contentDocument) {
    return null;
  }
  const doc = htmlFrame.contentDocument;
  const scriptEl = doc.getElementById("pdf-structure-map");
  if (!scriptEl) {
    return null;
  }
  try {
    return JSON.parse(scriptEl.textContent || "{}");
  } catch (e) {
    console.warn("Failed to parse structure map:", e);
    return null;
  }
}

function buildMcidToElementMap(structMap) {
  const map = new Map();
  if (!structMap) {
    return map;
  }
  for (const [elementId, info] of Object.entries(structMap)) {
    for (const mcid of info.mcids || []) {
      // Store the first element that references this MCID (closest in hierarchy)
      if (!map.has(mcid)) {
        map.set(mcid, { elementId, page: info.page });
      }
    }
  }
  return map;
}

function findTreeNodeByMcids(mcids) {
  // Find the tree node that best matches the given MCIDs
  // We look for nodes whose MCIDs overlap with the given set
  if (!mcids.length) {
    return null;
  }

  const mcidSet = new Set(mcids);
  let bestMatch = null;
  let bestOverlap = 0;

  for (const [nodeId, cachedIds] of structNodeContentIds) {
    if (!cachedIds || !cachedIds.length) {
      continue;
    }
    const overlap = cachedIds.filter((id) => mcidSet.has(id)).length;
    if (overlap > 0 && overlap > bestOverlap) {
      bestOverlap = overlap;
      bestMatch = nodeId;
    }
  }

  if (bestMatch) {
    const summary = structTreeEl?.querySelector(
      `summary[data-node-id="${bestMatch}"]`
    );
    return summary || null;
  }
  return null;
}

function highlightHtmlElement(elementId) {
  if (!htmlFrame?.contentDocument) {
    return;
  }
  const doc = htmlFrame.contentDocument;
  ensureHtmlHighlightStyle(doc);
  clearHtmlHighlights();

  const el = doc.getElementById(elementId);
  if (el) {
    el.classList.add(HTML_HIGHLIGHT_CLASS);
    activeHtmlHighlights.push(el);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function setupHtmlClickHandlers() {
  if (!htmlFrame?.contentDocument) {
    return;
  }
  const doc = htmlFrame.contentDocument;
  ensureHtmlHighlightStyle(doc);

  doc.body?.addEventListener("click", (event) => {
    // Find the closest element with an ID that starts with "pdf-se-"
    const target = event.target.closest('[id^="pdf-se-"], [id^="widget_"]');
    if (!target) {
      return;
    }

    const elementId = target.id;
    if (!htmlStructureMap || !htmlStructureMap[elementId]) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const info = htmlStructureMap[elementId];
    const mcids = info.mcids || [];

    // Highlight the HTML element
    clearHtmlHighlights();
    target.classList.add(HTML_HIGHLIGHT_CLASS);
    activeHtmlHighlights.push(target);

    // Highlight PDF view
    if (typeof info.page === "number") {
      setActivePage(info.page, { scroll: true });
    }

    clearHighlights();
    const highlighted = [];
    for (const mcid of mcids) {
      if (activeTextLayerEl) {
        const el = activeTextLayerEl.querySelector(`#${escapeCssId(mcid)}`);
        if (el) {
          el.classList.add("tag-highlight");
          highlighted.push(el);
        }
      }
    }
    activeHighlights = highlighted;
    if (highlighted.length > 0) {
      highlighted[0].scrollIntoView({ behavior: "smooth", block: "center" });
    }

    // Find and select the corresponding tree node
    const treeNode = findTreeNodeByMcids(mcids);
    if (treeNode) {
      if (activeSummary && activeSummary !== treeNode) {
        activeSummary.classList.remove("is-selected");
      }
      activeSummary = treeNode;
      activeSummary.classList.add("is-selected");

      // Expand parent details elements to make the node visible
      let parent = treeNode.parentElement;
      while (parent) {
        if (parent.tagName === "DETAILS") {
          parent.open = true;
        }
        parent = parent.parentElement;
      }
      treeNode.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
}

function highlightHtmlByIds(ids) {
  if (!htmlFrame?.contentDocument) {
    return;
  }
  const doc = htmlFrame.contentDocument;
  ensureHtmlHighlightStyle(doc);
  clearHtmlHighlights();
  const highlighted = [];
  const highlightedIds = new Set();

  // Use the structure map to find elements by their MCIDs
  for (const mcid of ids) {
    const info = mcidToElementMap.get(mcid);
    if (info && !highlightedIds.has(info.elementId)) {
      const el = doc.getElementById(info.elementId);
      if (el) {
        el.classList.add(HTML_HIGHLIGHT_CLASS);
        highlighted.push(el);
        highlightedIds.add(info.elementId);
      }
    }
  }

  activeHtmlHighlights = highlighted;
}

function buildMcidRoleMap(doc) {
  const map = new Map();
  const nodes = doc.querySelectorAll("[data-pdf-mcid]");
  nodes.forEach((node) => {
    const mcid = node.getAttribute("data-pdf-mcid");
    if (!mcid || map.has(mcid)) {
      return;
    }
    const owner = node.closest("[data-pdf-se-type]");
    if (!owner) {
      return;
    }
    const mapped = owner.getAttribute("data-pdf-se-type");
    if (!mapped) {
      return;
    }
    const original = owner.getAttribute("data-pdf-se-type-original") || mapped;
    map.set(mcid, { mapped, original });
  });
  return map;
}

function updateOriginalRolesFromHtml() {
  if (!htmlFrame?.contentDocument || !structTreeEl) {
    return;
  }
  const doc = htmlFrame.contentDocument;
  const mcidToRoles = buildMcidRoleMap(doc);
  const assignedMcids = new Set();
  const nodeOriginals = new Map();
  const nodes = Array.from(structNodeInfo.entries())
    .map(([nodeId, info]) => ({ nodeId, ...info }))
    .sort((a, b) => b.depth - a.depth);

  for (const node of nodes) {
    const ids = getContentIdsForNode(node.nodeId);
    for (const id of ids) {
      const roleInfo = mcidToRoles.get(id);
      if (!roleInfo || roleInfo.mapped !== node.role) {
        continue;
      }
      if (assignedMcids.has(id)) {
        continue;
      }
      assignedMcids.add(id);
      let set = nodeOriginals.get(node.nodeId);
      if (!set) {
        set = new Set();
        nodeOriginals.set(node.nodeId, set);
      }
      set.add(roleInfo.original);
    }
  }

  const summaries = structTreeEl.querySelectorAll("summary[data-node-id]");
  summaries.forEach((summary) => {
    const nodeId = summary.dataset.nodeId;
    if (!nodeId) {
      return;
    }
    const originalEl = summary.querySelector(".tree-original");
    if (originalEl) {
      const originals = nodeOriginals.get(nodeId);
      originalEl.textContent =
        originals && originals.size > 0
          ? Array.from(originals).join(", ")
          : "";
    }
  });
}

function scrollHtmlToContentIds(ids) {
  if (!htmlFrame?.contentDocument) {
    return;
  }
  const doc = htmlFrame.contentDocument;

  // Use the structure map to find elements
  for (const mcid of ids) {
    const info = mcidToElementMap.get(mcid);
    if (info) {
      const el = doc.getElementById(info.elementId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
  }
}

function collectContentIds(node, ids) {
  if (!node?.children) {
    return;
  }
  for (const child of node.children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    if ("type" in child && child.type === "content" && child.id) {
      ids.add(child.id);
      continue;
    }
    if ("role" in child) {
      collectContentIds(child, ids);
    }
  }
}

function getContentIdsForNode(nodeId) {
  const cached = structNodeContentIds.get(nodeId);
  if (cached) {
    return cached;
  }
  const node = structNodeMap.get(nodeId);
  const ids = new Set();
  collectContentIds(node, ids);
  const list = Array.from(ids);
  structNodeContentIds.set(nodeId, list);
  return list;
}

function highlightNode(nodeId, pageIndex, { scroll = false } = {}) {
  clearHighlights();
  if (typeof pageIndex === "number") {
    setActivePage(pageIndex, { scroll });
  }
  const ids = getContentIdsForNode(nodeId);
  if (!ids.length || !activeTextLayerEl) {
    return;
  }
  const highlighted = [];
  let firstHighlight = null;
  for (const id of ids) {
    const el = activeTextLayerEl.querySelector(`#${escapeCssId(id)}`);
    if (el) {
      el.classList.add("tag-highlight");
      highlighted.push(el);
      if (!firstHighlight) {
        firstHighlight = el;
      }
    }
  }
  activeHighlights = highlighted;
  highlightHtmlByIds(ids);
  if (scroll) {
    if (firstHighlight) {
      firstHighlight.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    scrollHtmlToContentIds(ids);
  }
}

function setActiveTreeNode(summary) {
  if (!summary) {
    return;
  }
  if (activeSummary && activeSummary !== summary) {
    activeSummary.classList.remove("is-selected");
  }
  activeSummary = summary;
  activeSummary.classList.add("is-selected");
  const nodeId = summary.dataset.nodeId;
  const pageIndex = summary.dataset.pageIndex
    ? Number.parseInt(summary.dataset.pageIndex, 10)
    : null;
  if (nodeId && Number.isFinite(pageIndex)) {
    highlightNode(nodeId, pageIndex, { scroll: true });
  }
}

function buildStructTreeNode(node, pageIndex, depth = 0) {
  const details = document.createElement("details");
  details.open = false;

  const summary = document.createElement("summary");
  summary.className = "tree-node";
  const nodeId = `node-${++structNodeCounter}`;
  summary.dataset.nodeId = nodeId;
  summary.dataset.pageIndex = String(pageIndex);
  structNodeMap.set(nodeId, node);
  structNodeInfo.set(nodeId, { role: node.role || "Unknown", depth });

  const roleLabel = document.createElement("span");
  roleLabel.className = "tree-role";
  roleLabel.textContent = node.role || "Unknown";
  summary.append(roleLabel);

  const originalLabel = document.createElement("span");
  originalLabel.className = "tree-original";
  summary.append(originalLabel);

  const contentIds = getContentIdsForNode(nodeId);
  if (contentIds.length > 0) {
    const meta = document.createElement("span");
    meta.className = "tree-meta";
    meta.textContent = `(${contentIds.length})`;
    summary.append(meta);
  }
  if (node.alt) {
    summary.title = node.alt;
  }

  details.append(summary);

  const childrenContainer = document.createElement("div");
  let hasChildren = false;
  for (const child of node.children || []) {
    if (child && typeof child === "object" && "role" in child) {
      childrenContainer.append(buildStructTreeNode(child, pageIndex, depth + 1));
      hasChildren = true;
    }
  }
  if (hasChildren) {
    details.append(childrenContainer);
  }

  return details;
}

function renderStructTreeAllPages(entries) {
  if (!structTreeEl) {
    return;
  }
  structTreeEl.innerHTML = "";
  structNodeCounter = 0;
  structNodeMap.clear();
  structNodeContentIds.clear();
  structNodeInfo.clear();
  clearTreeSelection();

  const fragment = document.createDocumentFragment();
  if (!entries.length) {
    structTreeEl.textContent = "No structure tree found in this PDF.";
    return;
  }

  entries.forEach((entry, index) => {
    const pageDetails = document.createElement("details");
    pageDetails.open = true;

    const pageSummary = document.createElement("summary");
    pageSummary.className = "tree-page";
    pageSummary.textContent = `Page ${entry.pageNumber}`;
    pageDetails.append(pageSummary);

    const childrenContainer = document.createElement("div");
    const root = entry.structTree;
    let hasChildren = false;
    for (const child of root?.children || []) {
      if (child && typeof child === "object" && "role" in child) {
        childrenContainer.append(buildStructTreeNode(child, index));
        hasChildren = true;
      }
    }
    if (!hasChildren) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = "No structure tree found.";
      childrenContainer.append(empty);
    }

    pageDetails.append(childrenContainer);
    fragment.append(pageDetails);
  });

  structTreeEl.append(fragment);
  updateOriginalRolesFromHtml();
}

function setActivePage(index, { scroll = false } = {}) {
  if (!pageEntries.length) {
    return;
  }
  const clampedIndex = Math.min(Math.max(index, 0), pageEntries.length - 1);
  const previous = pageEntries[activePageIndex];
  if (previous) {
    previous.pageEl.classList.remove("is-active");
  }
  activePageIndex = clampedIndex;
  const entry = pageEntries[activePageIndex];
  entry.pageEl.classList.add("is-active");
  activeTextLayerEl = entry.textLayerEl;
  if (scroll) {
    entry.pageEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function setupPdfTextLayerClickHandler(textLayer, pageIndex) {
  textLayer.addEventListener("click", (event) => {
    // Find element with an ID (MCID format: pageIndex_mcN)
    const target = event.target.closest("[id]");
    if (!target || !target.id) {
      return;
    }

    const mcid = target.id;
    // Check if this is a valid MCID format
    if (!mcid.includes("_mc")) {
      return;
    }

    event.stopPropagation();

    // Highlight the clicked PDF element
    clearHighlights();
    target.classList.add("tag-highlight");
    activeHighlights = [target];

    // Find and highlight the corresponding HTML element
    const info = mcidToElementMap.get(mcid);
    if (info) {
      highlightHtmlElement(info.elementId);
    }

    // Find and select the corresponding tree node
    const treeNode = findTreeNodeByMcids([mcid]);
    if (treeNode) {
      if (activeSummary && activeSummary !== treeNode) {
        activeSummary.classList.remove("is-selected");
      }
      activeSummary = treeNode;
      activeSummary.classList.add("is-selected");

      // Expand parent details elements
      let parent = treeNode.parentElement;
      while (parent) {
        if (parent.tagName === "DETAILS") {
          parent.open = true;
        }
        parent = parent.parentElement;
      }
      treeNode.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
}

function createPageEntry(pageNumber) {
  if (!pdfPagesEl) {
    return;
  }
  const pageEl = document.createElement("div");
  pageEl.className = "pdf-page";

  const label = document.createElement("div");
  label.className = "page-label";
  label.textContent = `Page ${pageNumber}`;

  const stage = document.createElement("div");
  stage.className = "pdf-stage";

  const canvas = document.createElement("canvas");
  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";

  stage.append(canvas, textLayer);
  pageEl.append(label, stage);
  pdfPagesEl.append(pageEl);

  pageEl.addEventListener("click", () => {
    setActivePage(pageNumber - 1, { scroll: false });
  });

  // Set up click handler for text layer elements
  setupPdfTextLayerClickHandler(textLayer, pageNumber - 1);

  return { pageEl, stage, canvas, textLayer };
}

function computeFitScale(page) {
  if (!pdfPagesEl) {
    return 1;
  }
  const baseViewport = page.getViewport({ scale: 1 });
  const containerWidth = pdfPagesEl.clientWidth;
  if (!containerWidth || !baseViewport.width) {
    return 1;
  }
  const padding = 16;
  const availableWidth = Math.max(0, containerWidth - padding);
  const scale = availableWidth / baseViewport.width;
  return scale > 0 ? scale : 1;
}

async function renderPdfPage(page, pageNumber, scale) {
  const entry = createPageEntry(pageNumber);
  if (!entry) {
    return null;
  }

  const viewport = page.getViewport({ scale });
  const outputScale = window.devicePixelRatio || 1;

  entry.stage.style.setProperty("--total-scale-factor", `${scale}`);
  entry.stage.style.width = `${viewport.width}px`;
  entry.stage.style.height = `${viewport.height}px`;

  entry.canvas.width = Math.floor(viewport.width * outputScale);
  entry.canvas.height = Math.floor(viewport.height * outputScale);
  entry.canvas.style.width = `${viewport.width}px`;
  entry.canvas.style.height = `${viewport.height}px`;

  const ctx = entry.canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas context is not available.");
  }

  const transform =
    outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
  await page.render({ canvasContext: ctx, viewport, transform }).promise;

  entry.textLayer.innerHTML = "";
  setLayerDimensions(entry.textLayer, viewport);
  const textContent = await page.getTextContent({
    includeMarkedContent: true,
    disableNormalization: true,
  });
  const textLayer = new TextLayer({
    textContentSource: textContent,
    container: entry.textLayer,
    viewport,
  });
  await textLayer.render();
  return entry;
}

async function renderPdfData(pdfData) {
  ensureWorker();
  showPdfPane();
  clearPdfLayer();
  resetStructTree("Reading structure tree...");

  if (pdfDoc) {
    await pdfDoc.destroy();
    pdfDoc = null;
  }

  const loadingTask = getDocument({ data: pdfData });
  pdfDoc = await loadingTask.promise;
  const totalPages = pdfDoc.numPages;
  pageEntries = [];

  const firstPage = await pdfDoc.getPage(1);
  currentScale = computeFitScale(firstPage);

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    setStatus(`Rendering page ${pageNumber} of ${totalPages}...`);
    const page = pageNumber === 1 ? firstPage : await pdfDoc.getPage(pageNumber);
    const entry = await renderPdfPage(page, pageNumber, currentScale);
    if (!entry) {
      continue;
    }
    entry.pageNumber = pageNumber;
    entry.textLayerEl = entry.textLayer;
    entry.structTree = await page.getStructTree();
    pageEntries.push(entry);
  }

  if (pageEntries.length) {
    renderStructTreeAllPages(pageEntries);
    setActivePage(0, { scroll: false });
  } else {
    resetStructTree("No pages found in this PDF.");
  }
}

async function convertPdfData(pdfData) {
  setStatus("Converting PDF to HTML...");
  const html = await deriveHtmlFromPdf(pdfData);
  htmlFrame.srcdoc = html;
}

async function handleFileSelection(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  setStatus(`Loading ${file.name}...`);
  const buffer = await file.arrayBuffer();
  const pdfData = new Uint8Array(buffer);
  const htmlData = pdfData.slice();

  await renderPdfData(pdfData);
  await convertPdfData(htmlData);

  setStatus("Done");
}

structTreeEl?.addEventListener("click", (event) => {
  const summary = event.target.closest("summary[data-node-id]");
  if (!summary || !structTreeEl.contains(summary)) {
    return;
  }
  setActiveTreeNode(summary);
});

pdfInput?.addEventListener("change", (event) => {
  handleFileSelection(event).catch((error) => {
    console.error(error);
    setStatus(`Error: ${error.message}`);
  });
});

htmlFrame?.addEventListener("load", () => {
  activeHtmlHighlights = [];

  // Load and initialize the structure map from the embedded JSON
  htmlStructureMap = loadStructureMapFromHtml();
  mcidToElementMap = buildMcidToElementMap(htmlStructureMap);

  // Set up click handlers for HTML element synchronization
  setupHtmlClickHandlers();

  updateOriginalRolesFromHtml();
});

setStatus(" ");
showPdfIntro();
