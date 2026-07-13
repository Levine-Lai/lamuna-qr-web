import { BrowserQRCodeReader } from "@zxing/browser";
import { DecodeHintType } from "@zxing/library";
import jsQR from "jsqr";
import JSZip from "jszip";
import qrcode from "qrcode-generator";
import {
  applyItemToTemplate,
  buildTemplateIndex,
  builtInTemplates,
  findTemplates,
  parseItemText,
  parseLamunaSummary,
  pickTemplate,
  sanitizeFilename,
  type ItemText,
  type TemplateRecord,
} from "./lamuna";
import "./styles.css";

type ResultRow = {
  status: "ok" | "error" | "skip";
  oldFile: string;
  project: string;
  batch: string;
  templateFile: string;
  outputFile: string;
  detail: string;
  blob?: Blob;
  url?: string;
};

const decodeHints = new Map<DecodeHintType, unknown>([
  [DecodeHintType.TRY_HARDER, true],
]);
const codeReader = new BrowserQRCodeReader(decodeHints);
const resultRows: ResultRow[] = [];
const activeUrls = new Set<string>();

const form = document.querySelector<HTMLFormElement>("#convertForm")!;
const oldInput = document.querySelector<HTMLInputElement>("#oldFiles")!;
const templateInput = document.querySelector<HTMLInputElement>("#templateFiles")!;
const convertButton = document.querySelector<HTMLButtonElement>("#convertButton")!;
const zipButton = document.querySelector<HTMLButtonElement>("#zipButton")!;
const clearButton = document.querySelector<HTMLButtonElement>("#clearButton")!;
const resultBody = document.querySelector<HTMLTableSectionElement>("#resultBody")!;
const templateStatus = document.querySelector<HTMLParagraphElement>("#templateStatus")!;
const oldFileStatus = document.querySelector<HTMLElement>("#oldFileStatus")!;
const templateFileStatus = document.querySelector<HTMLElement>("#templateFileStatus")!;
const actionStatus = document.querySelector<HTMLParagraphElement>("#actionStatus")!;

templateStatus.textContent = `已内置 ${builtInTemplates.length} 个新版本模板`;
setMetric("templateCount", String(builtInTemplates.length));

function setMetric(id: string, value: string): void {
  document.querySelector<HTMLElement>(`#${id}`)!.textContent = value;
}

function setBusy(isBusy: boolean, text?: string): void {
  convertButton.disabled = isBusy;
  convertButton.textContent = isBusy ? "正在生成..." : "生成新二维码";
  actionStatus.classList.toggle("busy", isBusy);
  actionStatus.textContent = isBusy ? text ?? "正在处理" : "就绪";
  zipButton.disabled = isBusy || !resultRows.some((row) => row.status === "ok");
  templateStatus.textContent = isBusy
    ? text ?? "处理中"
    : `已内置 ${builtInTemplates.length} 个新版本模板`;
}

function setFiles(input: HTMLInputElement, files: FileList): void {
  const transfer = new DataTransfer();
  Array.from(files).forEach((file) => transfer.items.add(file));
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function formatFileStatus(files: FileList | null, emptyText: string): string {
  const selected = Array.from(files ?? []);
  if (selected.length === 0) {
    return emptyText;
  }
  const shown = selected.slice(0, 3).map((file) => file.name).join("，");
  const more = selected.length > 3 ? `，另有 ${selected.length - 3} 个` : "";
  return `已选择 ${selected.length} 个文件：${shown}${more}`;
}

function updateFileStatuses(): void {
  oldFileStatus.textContent = formatFileStatus(oldInput.files, "未选择旧二维码");
  templateFileStatus.textContent = formatFileStatus(templateInput.files, "未选择补充模板");
}

function setupDropZone(zoneId: string, input: HTMLInputElement): void {
  const zone = document.querySelector<HTMLElement>(zoneId)!;
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("dragging");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("dragging");
    if (event.dataTransfer?.files.length) {
      setFiles(input, event.dataTransfer.files);
    }
  });
}

setupDropZone("#oldDropZone", oldInput);
setupDropZone("#templateDropZone", templateInput);
oldInput.addEventListener("change", updateFileStatuses);
templateInput.addEventListener("change", updateFileStatuses);
updateFileStatuses();

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片读取失败"));
    image.src = url;
  });
}

async function decodeWithZxing(url: string): Promise<string> {
  const reader = codeReader as unknown as {
    decodeFromImageUrl?: (url: string) => Promise<{ getText?: () => string; text?: string }>;
  };
  if (!reader.decodeFromImageUrl) {
    throw new Error("ZXing 当前版本没有 decodeFromImageUrl");
  }
  const result = await reader.decodeFromImageUrl(url);
  const text = result.getText?.() ?? result.text;
  if (!text) {
    throw new Error("二维码内容为空");
  }
  return text;
}

type EnhancedQrDecoder = (imageData: ImageData) => Promise<string | null>;

async function decodeWithJsQr(url: string, enhancedDecoder?: EnhancedQrDecoder): Promise<string> {
  const image = await loadImage(url);
  const source = document.createElement("canvas");
  const sourceScale = Math.min(1, 2800 / Math.max(image.naturalWidth, image.naturalHeight));
  source.width = Math.max(1, Math.round(image.naturalWidth * sourceScale));
  source.height = Math.max(1, Math.round(image.naturalHeight * sourceScale));
  const sourceCtx = source.getContext("2d", { willReadFrequently: true });
  if (!sourceCtx) throw new Error("无法创建图片画布");
  sourceCtx.drawImage(image, 0, 0, source.width, source.height);

  type Crop = { x: number; y: number; width: number; height: number };
  const crops: Crop[] = [{ x: 0, y: 0, width: source.width, height: source.height }];

  // Phone photos are commonly portrait while the QR itself is square. Sliding
  // square windows avoid clipping a finder pattern with portrait-shaped crops.
  const shortEdge = Math.min(source.width, source.height);
  for (const fraction of [0.75, 0.55]) {
    const size = Math.round(shortEdge * fraction);
    const step = Math.max(1, Math.round(size * 0.55));
    const xPositions = new Set<number>();
    const yPositions = new Set<number>();
    for (let x = 0; x < source.width - size; x += step) xPositions.add(x);
    for (let y = 0; y < source.height - size; y += step) yPositions.add(y);
    xPositions.add(Math.max(0, source.width - size));
    yPositions.add(Math.max(0, source.height - size));
    for (const y of yPositions) {
      for (const x of xPositions) crops.push({ x, y, width: size, height: size });
    }
  }

  // Dense QR codes in phone photos often occupy only a small part of the image.
  // Overlapping crops preserve enough pixels per module without needing CV/WASM.
  for (const fraction of [0.62, 0.42]) {
    const width = Math.round(source.width * fraction);
    const height = Math.round(source.height * fraction);
    const positions = fraction > 0.5 ? [0, 0.5, 1] : [0, 1 / 3, 2 / 3, 1];
    for (const py of positions) {
      for (const px of positions) {
        crops.push({
          x: Math.round((source.width - width) * px),
          y: Math.round((source.height - height) * py),
          width,
          height,
        });
      }
    }
  }

  const tryCanvas = async (canvas: HTMLCanvasElement): Promise<string | null> => {
    const data = canvas.getContext("2d", { willReadFrequently: true })?.getImageData(0, 0, canvas.width, canvas.height);
    if (!data) return null;
    const result = jsQR(data.data, data.width, data.height, { inversionAttempts: "attemptBoth" });
    if (result?.data) return result.data;

    if (enhancedDecoder) {
      try {
        const decoded = await enhancedDecoder(data);
        if (decoded) return decoded;
      } catch {
        // Continue with the lightweight ZXing fallback.
      }
    }

    const reader = codeReader as unknown as {
      decodeFromCanvas?: (canvas: HTMLCanvasElement) => Promise<{ getText?: () => string; text?: string }>;
    };
    try {
      const decoded = await reader.decodeFromCanvas?.(canvas);
      return decoded?.getText?.() ?? decoded?.text ?? null;
    } catch {
      return null;
    }
  };

  for (const crop of crops) {
    const scale = Math.min(3, 1500 / Math.max(crop.width, crop.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(crop.width * scale));
    canvas.height = Math.max(1, Math.round(crop.height * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) continue;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);

    const plain = await tryCanvas(canvas);
    if (plain) return plain;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let min = 255;
    let max = 0;
    for (let index = 0; index < imageData.data.length; index += 4) {
      const gray = Math.round(
        imageData.data[index] * 0.299 + imageData.data[index + 1] * 0.587 + imageData.data[index + 2] * 0.114,
      );
      imageData.data[index] = gray;
      imageData.data[index + 1] = gray;
      imageData.data[index + 2] = gray;
      min = Math.min(min, gray);
      max = Math.max(max, gray);
    }
    const range = Math.max(1, max - min);
    for (let index = 0; index < imageData.data.length; index += 4) {
      const gray = Math.max(0, Math.min(255, Math.round(((imageData.data[index] - min) * 255) / range)));
      imageData.data[index] = gray;
      imageData.data[index + 1] = gray;
      imageData.data[index + 2] = gray;
    }
    ctx.putImageData(imageData, 0, 0);

    const contrasted = await tryCanvas(canvas);
    if (contrasted) return contrasted;

    // A few thresholds cover shadows and low contrast common in handheld photos.
    for (const threshold of [96, 128, 160]) {
      const binary = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
      for (let index = 0; index < binary.data.length; index += 4) {
        const value = binary.data[index] < threshold ? 0 : 255;
        binary.data[index] = value;
        binary.data[index + 1] = value;
        binary.data[index + 2] = value;
      }
      ctx.putImageData(binary, 0, 0);
      const decoded = await tryCanvas(canvas);
      if (decoded) return decoded;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("没有识别到二维码，请尽量正对二维码拍摄并保持清晰");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("识别超时")), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function decodeQrFile(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    try {
      return await withTimeout(decodeWithZxing(url), 8000);
    } catch {
      try {
        const { readBarcodes, prepareZXingModule } = await import("zxing-wasm/reader");
        const wasmUrl = new URL("zxing_reader.wasm", document.baseURI).href;
        prepareZXingModule({ overrides: { locateFile: () => wasmUrl } });
        const decodeWithWasm = async (input: Blob | ImageData): Promise<string | null> => {
          const results = await readBarcodes(input, {
            formats: ["QRCode"],
            tryHarder: true,
            tryRotate: true,
            tryInvert: true,
            tryDownscale: true,
            maxNumberOfSymbols: 1,
          });
          return results[0]?.text ?? null;
        };
        const text = await withTimeout(decodeWithWasm(file), 20000);
        if (text) return text;
        return await withTimeout(
          decodeWithJsQr(url, (imageData) => withTimeout(decodeWithWasm(imageData), 5000)),
          45000,
        );
      } catch {
        // Continue with the image-enhancement fallback below.
      }
      return await withTimeout(decodeWithJsQr(url), 45000);
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawCenteredText(
  ctx: CanvasRenderingContext2D,
  text: string,
  box: { left: number; top: number; width: number; height: number },
  maxFontSize: number,
): void {
  let fontSize = maxFontSize;
  while (fontSize > 18) {
    ctx.font = `700 ${fontSize}px Arial, "Microsoft YaHei UI", sans-serif`;
    if (ctx.measureText(text).width <= box.width - 8) {
      break;
    }
    fontSize -= 1;
  }
  ctx.font = `700 ${fontSize}px Arial, "Microsoft YaHei UI", sans-serif`;
  ctx.fillStyle = "#000";
  ctx.textBaseline = "alphabetic";
  const metrics = ctx.measureText(text);
  const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.78;
  const descent = metrics.actualBoundingBoxDescent || fontSize * 0.22;
  const x = box.left + (box.width - metrics.width) / 2;
  const y = box.top + (box.height - ascent - descent) / 2 + ascent;
  ctx.fillText(text, x, y);
}

function renderQrCanvas(payload: string, item: ItemText): HTMLCanvasElement {
  const qr = qrcode(0, "M");
  qr.addData(payload);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const border = 1;
  const boxSize = 10;
  const qrRawSize = (moduleCount + border * 2) * boxSize;
  const qrCanvas = document.createElement("canvas");
  qrCanvas.width = qrRawSize;
  qrCanvas.height = qrRawSize;
  const qrCtx = qrCanvas.getContext("2d")!;
  qrCtx.fillStyle = "#fff";
  qrCtx.fillRect(0, 0, qrRawSize, qrRawSize);
  qrCtx.fillStyle = "#000";
  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (qr.isDark(row, col)) {
        qrCtx.fillRect((col + border) * boxSize, (row + border) * boxSize, boxSize, boxSize);
      }
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = 495;
  canvas.height = 400;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const strip = document.createElement("canvas");
  strip.width = 400;
  strip.height = 95;
  const stripCtx = strip.getContext("2d")!;
  stripCtx.fillStyle = "#fff";
  stripCtx.fillRect(0, 0, strip.width, strip.height);
  drawCenteredText(stripCtx, item.name, { left: 0, top: 0, width: 400, height: 45 }, 41);
  drawCenteredText(stripCtx, item.batch, { left: 0, top: 45, width: 400, height: 50 }, 41);

  ctx.save();
  ctx.translate(3, 400);
  ctx.rotate(-Math.PI / 2);
  ctx.drawImage(strip, 0, 0);
  ctx.restore();

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(qrCanvas, 95, 0, 400, 400);
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("图片生成失败"));
        }
      },
      "image/jpeg",
      0.95,
    );
  });
}

async function readManualTemplates(files: File[]): Promise<{ templates: TemplateRecord[]; errors: string[] }> {
  const templates: TemplateRecord[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      const payload = await decodeQrFile(file);
      if (payload.startsWith("ITEM|")) {
        throw new Error("这是旧版 ITEM 二维码，不是新版本模板");
      }
      const summary = parseLamunaSummary(payload);
      if (!summary.name) {
        throw new Error("模板里没有项目名称");
      }
      templates.push({
        ...summary,
        file: file.name,
        payload,
        source: "手动模板",
      });
    } catch (error) {
      errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { templates, errors };
}

function uniqueOutputName(item: ItemText, usedNames: Set<string>): string {
  const base = `${sanitizeFilename(item.name)}-${sanitizeFilename(item.batch)}`;
  let name = `${base}.jpg`;
  let index = 2;
  while (usedNames.has(name)) {
    name = `${base}_${index}.jpg`;
    index += 1;
  }
  usedNames.add(name);
  return name;
}

async function verifyGenerated(blob: Blob, filename: string, expectedPayload: string): Promise<void> {
  const file = new File([blob], filename, { type: "image/jpeg" });
  const actualPayload = await decodeQrFile(file);
  if (actualPayload !== expectedPayload) {
    throw new Error("新二维码反扫校验失败");
  }
}

async function convertFiles(oldFiles: File[], manualTemplates: TemplateRecord[]): Promise<ResultRow[]> {
  const templates = [...builtInTemplates, ...manualTemplates];
  const templateIndex = buildTemplateIndex(templates);
  const rows: ResultRow[] = [];
  const usedNames = new Set<string>();

  for (const [index, file] of oldFiles.entries()) {
    setBusy(true, `处理中 ${index + 1}/${oldFiles.length}: ${file.name}`);
    const row: ResultRow = {
      status: "error",
      oldFile: file.name,
      project: "",
      batch: "",
      templateFile: "",
      outputFile: "",
      detail: "",
    };
    try {
      const oldPayload = await decodeQrFile(file);
      if (!oldPayload.startsWith("ITEM|")) {
        row.status = "skip";
        row.detail = "不是旧版 ITEM 二维码";
        rows.push(row);
        continue;
      }
      const item = parseItemText(oldPayload);
      row.project = item.name;
      row.batch = item.batch;
      const candidates = findTemplates(templateIndex, item.name);
      if (candidates.length === 0) {
        throw new Error(`没有找到 ${item.name} 的新版本模板，需要手动导入同项目新版本二维码`);
      }
      const template = pickTemplate(candidates, item);
      const newPayload = applyItemToTemplate(template, item);
      const canvas = renderQrCanvas(newPayload, item);
      const blob = await canvasToBlob(canvas);
      const outputFile = uniqueOutputName(item, usedNames);
      await verifyGenerated(blob, outputFile, newPayload);
      const url = URL.createObjectURL(blob);
      activeUrls.add(url);
      row.status = "ok";
      row.templateFile = template.file;
      row.outputFile = outputFile;
      row.detail = `${template.source}，已反扫校验`;
      row.blob = blob;
      row.url = url;
    } catch (error) {
      row.status = "error";
      row.detail = error instanceof Error ? error.message : String(error);
    }
    rows.push(row);
    renderRows(rows);
  }

  return rows;
}

function clearObjectUrls(): void {
  activeUrls.forEach((url) => URL.revokeObjectURL(url));
  activeUrls.clear();
}

function clearResults(): void {
  clearObjectUrls();
  resultRows.splice(0, resultRows.length);
  renderRows(resultRows);
}

function appendTextCell(tr: HTMLTableRowElement, text: string, className?: string): void {
  const td = document.createElement("td");
  td.textContent = text || "-";
  if (className) {
    td.className = className;
  }
  tr.appendChild(td);
}

function renderRows(rows: ResultRow[]): void {
  setMetric("totalCount", String(rows.length));
  setMetric("okCount", String(rows.filter((row) => row.status === "ok").length));
  setMetric("errorCount", String(rows.filter((row) => row.status === "error").length));
  zipButton.disabled = !rows.some((row) => row.status === "ok") || convertButton.disabled;

  resultBody.innerHTML = "";
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 9;
    td.className = "empty";
    td.textContent = "等待上传旧二维码";
    tr.appendChild(td);
    resultBody.appendChild(tr);
    return;
  }

  for (const row of rows) {
    const tr = document.createElement("tr");
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge ${row.status}`;
    badge.textContent = row.status;
    statusCell.appendChild(badge);
    tr.appendChild(statusCell);

    appendTextCell(tr, row.oldFile);
    appendTextCell(tr, row.project);
    appendTextCell(tr, row.batch);
    appendTextCell(tr, row.templateFile);
    appendTextCell(tr, row.outputFile);

    const downloadCell = document.createElement("td");
    if (row.url && row.outputFile) {
      const link = document.createElement("a");
      link.className = "download-link";
      link.href = row.url;
      link.download = row.outputFile;
      link.textContent = "下载图片";
      downloadCell.appendChild(link);
    } else {
      downloadCell.textContent = "-";
      downloadCell.className = "muted";
    }
    tr.appendChild(downloadCell);

    const previewCell = document.createElement("td");
    if (row.url && row.outputFile) {
      const image = document.createElement("img");
      image.className = "preview";
      image.src = row.url;
      image.alt = row.outputFile;
      previewCell.appendChild(image);
    } else {
      previewCell.textContent = "-";
      previewCell.className = "muted";
    }
    tr.appendChild(previewCell);

    appendTextCell(tr, row.detail);
    resultBody.appendChild(tr);
  }
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildReportCsv(rows: ResultRow[]): string {
  const headers = ["状态", "旧文件", "项目", "批号", "模板", "新文件", "详情"];
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      [
        row.status,
        row.oldFile,
        row.project,
        row.batch,
        row.templateFile,
        row.outputFile,
        row.detail,
      ]
        .map(csvEscape)
        .join(","),
    ),
  ];
  return `\ufeff${lines.join("\r\n")}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const oldFiles = Array.from(oldInput.files ?? []);
  const extraTemplateFiles = Array.from(templateInput.files ?? []);
  if (oldFiles.length === 0) {
    templateStatus.textContent = "请选择旧二维码图片";
    return;
  }

  clearResults();
  setBusy(true, "正在读取补充模板");
  try {
    const manual = await readManualTemplates(extraTemplateFiles);
    if (manual.errors.length) {
      console.warn("部分补充模板未读取", manual.errors);
    }
    setMetric("templateCount", String(builtInTemplates.length + manual.templates.length));
    const rows = await convertFiles(oldFiles, manual.templates);
    resultRows.splice(0, resultRows.length, ...rows);
    renderRows(resultRows);
    const ok = rows.filter((row) => row.status === "ok").length;
    const total = rows.length;
    const templateErrorNote = manual.errors.length ? `，${manual.errors.length} 个补充模板未读取` : "";
    templateStatus.textContent = `完成：${ok}/${total}${templateErrorNote}`;
    actionStatus.textContent = ok === total ? `生成完成：${ok}/${total}` : `处理完成：成功 ${ok}，失败 ${total - ok}`;
  } catch (error) {
    templateStatus.textContent = error instanceof Error ? error.message : String(error);
    actionStatus.textContent = `处理失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    convertButton.disabled = false;
    convertButton.textContent = "生成新二维码";
    actionStatus.classList.remove("busy");
    zipButton.disabled = !resultRows.some((row) => row.status === "ok");
  }
});

zipButton.addEventListener("click", async () => {
  const okRows = resultRows.filter((row) => row.status === "ok" && row.blob && row.outputFile);
  if (!okRows.length) {
    return;
  }
  zipButton.disabled = true;
  zipButton.textContent = "正在打包";
  try {
    const zip = new JSZip();
    for (const row of okRows) {
      zip.file(row.outputFile, row.blob!);
    }
    zip.file("conversion_report.csv", buildReportCsv(resultRows));
    const blob = await zip.generateAsync({ type: "blob" });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    downloadBlob(blob, `Lamuna_QR_${stamp}.zip`);
  } finally {
    zipButton.textContent = "下载全部";
    zipButton.disabled = false;
  }
});

clearButton.addEventListener("click", () => {
  oldInput.value = "";
  templateInput.value = "";
  updateFileStatuses();
  clearResults();
  setMetric("templateCount", String(builtInTemplates.length));
  templateStatus.textContent = `已内置 ${builtInTemplates.length} 个新版本模板`;
  actionStatus.textContent = "就绪";
  actionStatus.classList.remove("busy");
});

renderRows(resultRows);
