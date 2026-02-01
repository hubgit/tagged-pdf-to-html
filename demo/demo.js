import { deriveHtmlFromPdf } from "../src/index.ts";

const statusEl = document.getElementById("status");
const pdfIntro = document.getElementById("pdf-intro");
const pdfFrame = document.getElementById("pdf-frame");
const htmlFrame = document.getElementById("html-frame");
const pdfInput = document.getElementById("pdf-input");
let currentObjectUrl = null;

function setStatus(message) {
  statusEl.textContent = message;
}

function showPdfIntro() {
  pdfIntro?.classList.remove("is-hidden");
  pdfFrame.classList.add("is-hidden");
  pdfFrame.src = "";
}

function showPdfFrame() {
  pdfIntro?.classList.add("is-hidden");
  pdfFrame.classList.remove("is-hidden");
}

function setPdfPreview(url, { isObjectUrl = false } = {}) {
  if (currentObjectUrl && currentObjectUrl !== url) {
    URL.revokeObjectURL(currentObjectUrl);
  }
  currentObjectUrl = isObjectUrl ? url : null;
  showPdfFrame();
  pdfFrame.src = url;
}

async function convertPdfData(pdfData) {
  setStatus("Converting PDF to HTML...");
  const html = await deriveHtmlFromPdf(pdfData);
  htmlFrame.srcdoc = html;
  setStatus("Done.");
}

async function handleFileSelection(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  setStatus(`Loading ${file.name}...`);
  const objectUrl = URL.createObjectURL(file);
  setPdfPreview(objectUrl, { isObjectUrl: true });

  const buffer = await file.arrayBuffer();
  await convertPdfData(new Uint8Array(buffer));
}

pdfInput?.addEventListener("change", (event) => {
  handleFileSelection(event).catch((error) => {
    console.error(error);
    setStatus(`Error: ${error.message}`);
  });
});

setStatus(" ");
showPdfIntro();
