/**
 * Ark KB — Ingester
 * File ingestion: detect type → hash → chunk → embed → upsert into store.
 * Handles text, images, and PDFs with configurable chunking.
 */

import { readFile, stat, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, basename, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { KnowledgeStore, KBEntry } from "./store.js";
import { Embedder, exposeMediaFile } from "./embedder.js";
import { summarizeVideo, summarizeImage } from "./video.js";
import { dirname } from "node:path";
import { IngesterConfig } from "./index.js";

// ============================================================================
// File type detection
// ============================================================================

const SUPPORTED_TEXT_EXTS = new Set([
  ".md", ".txt", ".csv",
  ".json", ".yaml", ".yml", ".xml",
  ".py", ".js", ".ts", ".jsx", ".tsx",
  ".java", ".c", ".cpp", ".h", ".go",
  ".rs", ".rb", ".php", ".sh", ".bash",
  ".sql", ".r", ".scala", ".lua", ".toml",
  ".css", ".scss", ".less",       // 前端样式
  ".vue",                          // Vue SFC
  ".swift", ".kt", ".dart",        // 移动端
  ".log", ".conf", ".cfg", ".ini", ".env",  // 运维配置
  ".tex", ".rst", ".org", ".adoc", // 学术/文档
]);

const SUPPORTED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".jfif", ".webp", ".gif", ".bmp", ".svg", ".tiff", ".tif", ".ico", ".heic", ".heif", ".raw", ".cr2", ".nef", ".arw"]);
const SUPPORTED_VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".wmv", ".flv", ".m4v", ".3gp", ".ogv", ".ts"]);

export type FileKind = "text" | "image" | "video" | "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "html" | "unsupported";

export function detectFileKind(filePath: string): FileKind {
  const ext = extname(filePath).toLowerCase();
  if (SUPPORTED_TEXT_EXTS.has(ext)) return "text";
  if (SUPPORTED_IMAGE_EXTS.has(ext)) return "image";
  if (SUPPORTED_VIDEO_EXTS.has(ext)) return "video";
  if (ext === ".pdf") return "pdf";
  if (ext === ".doc") return "doc";
  if (ext === ".docx") return "docx";
  if (ext === ".xls") return "xls";
  if (ext === ".xlsx") return "xlsx";
  if (ext === ".ppt") return "ppt";
  if (ext === ".pptx") return "pptx";
  if (ext === ".html" || ext === ".htm") return "html";
  return "unsupported";
}

// ============================================================================
// Content hashing
// ============================================================================

export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// ============================================================================
// Chunking strategies
// ============================================================================

/**
 * Split text into chunks using the configured strategy.
 * Tokens are approximated as chars for CJK text.
 */
export function chunkText(
  text: string,
  config: { maxTokens: number; overlapTokens: number; strategy: string },
): string[] {
  switch (config.strategy) {
    case "fixed":
      return chunkFixed(text, config.maxTokens, config.overlapTokens);
    case "sentence":
      return chunkBySentence(text, config.maxTokens, config.overlapTokens);
    case "paragraph":
    default:
      return chunkByParagraph(text, config.maxTokens, config.overlapTokens);
  }
}

function chunkByParagraph(
  text: string,
  maxTokens: number,
  overlapTokens: number,
): string[] {
  // Split on blank lines (paragraph boundary)
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  const chunks: string[] = [];
  let current = "";
  const overlap = overlapTokens;

  for (const para of paragraphs) {
    if (current.length + para.length > maxTokens && current.length > 0) {
      chunks.push(current.trim());
      // Keep last overlap chars as context carryover
      current = (overlap > 0 ? current.slice(-overlap) : "") + "\n\n" + para;
    } else {
      current += (current.length > 0 ? "\n\n" : "") + para;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

function chunkFixed(
  text: string,
  maxTokens: number,
  overlapTokens: number,
): string[] {
  const chunks: string[] = [];
  let start = 0;
  const overlap = overlapTokens;

  while (start < text.length) {
    const end = start + maxTokens;
    chunks.push(text.slice(start, end));
    start = end - overlap;
    if (start >= text.length) break;
  }

  return chunks;
}

function chunkBySentence(
  text: string,
  maxTokens: number,
  overlapTokens: number,
): string[] {
  // Split on sentence-ending punctuation (handles CJK and western)
  const sentences = text.split(/(?<=[。！？.!?])\s*/).filter(s => s.trim().length > 0);
  const chunks: string[] = [];
  let current = "";
  const overlap = overlapTokens;

  for (const sentence of sentences) {
    if (current.length + sentence.length > maxTokens && current.length > 0) {
      chunks.push(current.trim());
      current = current.slice(-overlap) + sentence;
    } else {
      current += (current.length > 0 ? " " : "") + sentence;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

// ============================================================================
// PDF processing
// ============================================================================

/**
 * Extract text from PDF using MinerU API or built-in pdf-parse.
 */
export async function extractPdfText(
  filePath: string,
  pdfConfig: NonNullable<IngesterConfig["pdfParser"]>,
): Promise<string> {
  if (pdfConfig.api === "mineru" && pdfConfig.endpoint) {
    return await extractPdfMinerU(filePath, pdfConfig);
  }

  // Built-in pdf-parse fallback
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse: (buf: Buffer) => Promise<{ text: string }> = (await import("pdf-parse")).default as any;
    const dataBuffer = await readFile(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text || "";
  } catch (err: any) {
    throw new Error(`PDF parsing failed for ${filePath}: both MinerU and pdf-parse are unavailable. ${err.message}`);
  }
}

async function extractPdfMinerU(
  filePath: string,
  config: NonNullable<IngesterConfig["pdfParser"]>,
  opts?: { modelVersion?: string },
): Promise<string> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");

  // Step 0: Expose PDF as a URL (MinerU prefers URL over base64 for large files)
  let pdfUrl: string;
  const serveDir = "/var/www/downloads";
  if (fs.existsSync(serveDir)) {
    const fileName = path.basename(filePath);
    const dest = path.join(serveDir, fileName);
    fs.copyFileSync(filePath, dest);
    fs.chmodSync(dest, 0o644);
    pdfUrl = `https://home.sfunds.cn:8444/${encodeURIComponent(fileName)}`;
  } else {
    // No nginx — fallback to base64 for small files (<2MB)
    const stat = fs.statSync(filePath);
    if (stat.size > 2 * 1024 * 1024) {
      throw new Error("PDF too large for base64 (>2MB) and no HTTP server available. Install nginx or use builtin parser.");
    }
    const fileBuffer = fs.readFileSync(filePath);
    pdfUrl = fileBuffer.toString("base64");
  }

  // Merge user params with sensible defaults
  const submitBody: Record<string, any> = {
    enable_formula: true,
    enable_table: true,
    ...(config.params ?? {}),
  };
  if (opts?.modelVersion) {
    submitBody.model_version = opts.modelVersion;
  }
  // Use url or file depending on what we generated
  if (pdfUrl.startsWith("https://")) {
    submitBody.url = pdfUrl;
  } else {
    submitBody.file = pdfUrl;
    submitBody.file_name = path.basename(filePath);
  }

  // Step 1: Submit task
  const submitRes = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey || ""}`,
    },
    body: JSON.stringify(submitBody),
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    throw new Error(`MinerU submit error (${submitRes.status}): ${errText}`);
  }

  const submitData = await submitRes.json() as any;
  if (submitData.code !== 0) {
    throw new Error(`MinerU submit failed: ${submitData.msg || JSON.stringify(submitData)}`);
  }
  const taskId = submitData.data?.task_id;
  if (!taskId) throw new Error(`MinerU submit returned no task_id`);

  // Step 2: Poll until done
  const pollUrl = `${config.endpoint}/${taskId}`;
  const timeoutMs = 300_000; // 5 min
  const intervalMs = 5_000;
  const startTime = Date.now();
  let fullZipUrl = "";

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const pollRes = await fetch(pollUrl, {
      headers: { "Authorization": `Bearer ${config.apiKey || ""}` },
    });
    if (!pollRes.ok) {
      const errText = await pollRes.text();
      throw new Error(`MinerU poll error (${pollRes.status}): ${errText}`);
    }

    const pollData = await pollRes.json() as any;
    if (pollData.code !== 0) {
      throw new Error(`MinerU poll failed: ${pollData.msg || JSON.stringify(pollData)}`);
    }

    const state = pollData.data?.state;
    if (state === "done") {
      fullZipUrl = pollData.data?.full_zip_url;
      if (!fullZipUrl) throw new Error(`MinerU task done but no full_zip_url`);
      const totalPages = pollData.data?.extract_progress?.total_pages;
      if (totalPages) console.log(`[Ark KB] MinerU task ${taskId.slice(0,8)} done (${totalPages} pages)`);
      break;
    }
    if (state === "failed") {
      throw new Error(`MinerU task failed: ${pollData.data?.err_msg || "unknown"}`);
    }
    const progress = pollData.data?.extract_progress;
    const pageInfo = progress?.total_pages ? ` [page ${progress.extracted_pages ?? "?"}/${progress.total_pages}]` : "";
    console.log(`[Ark KB] MinerU polling ${taskId.slice(0,8)}... state=${state} (${Math.round((Date.now()-startTime)/1000)}s)${pageInfo}`);
  }

  if (!fullZipUrl) {
    throw new Error(`MinerU task ${taskId} timed out after ${timeoutMs/1000}s`);
  }

  // Step 3: Download and extract full.md
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ark-mineru-"));
  const zipPath = path.join(tmpDir, "result.zip");

  try {
    const zipRes = await fetch(fullZipUrl);
    if (!zipRes.ok) throw new Error(`MinerU download error (${zipRes.status})`);
    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
    fs.writeFileSync(zipPath, zipBuffer);

    // Extract using Node.js built-in (zlib + unzip via child_process)
    const childProcess = await import("node:child_process");
    const extractResult = childProcess.execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const fullMdPath = path.join(tmpDir, "full.md");
    if (fs.existsSync(fullMdPath)) {
      const text = fs.readFileSync(fullMdPath, "utf-8");
      return text;
    }

    // Look for any .md file
    const files = fs.readdirSync(tmpDir);
    const mdFile = files.find((f) => f.endsWith(".md"));
    if (mdFile) {
      return fs.readFileSync(path.join(tmpDir, mdFile), "utf-8");
    }

    throw new Error(`No .md file found in MinerU result (files: ${files.join(", ")})`);
  } finally {
    // Cleanup temp directory
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function extractPdfBuiltin(filePath: string): Promise<string> {
  // Fallback: read raw bytes and extract visible ASCII text
  const content = await readFile(filePath);
  const text = content.toString("latin1");
  // Very rough extraction — just grab printable ASCII strings > 10 chars
  const matches = text.match(/[\x20-\x7E\n\r]{10,}/g) || [];
  return matches.join("\n");
}

// ============================================================================
// Docx complexity auto-detection
// ============================================================================

/** Check if a .docx file is complex (has formulas, images, multi-column, etc.)
 *  by reading its internal XML structure. Returns true if ANY complexity marker is found. */
function isDocxComplex(filePath: string): boolean {

  try {
    // Extract word/document.xml from the docx ZIP
    const docXml = execSync(
      `unzip -p "${filePath}" word/document.xml`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 },
    );

    // 10 complexity markers (ECMA-376 / ISO 29500 standard tags)
    const markers = [
      "m:oMath",             // 1: Mathematical formulas (OMML)
      "m:oMathPara",         // 2: Formula paragraphs
      "w:drawing",           // 3: Embedded images/charts
      "mc:AlternateContent", // 4: Compatibility content (usually wraps charts)
      "w:txbxContent",       // 5: Text boxes (floating elements)
      "w:object",            // 6: OLE embedded objects (embedded Excel, etc.)
      "w:altChunk",          // 7: External content embedding
      "w:subDoc",            // 8: Master/sub-document structure
      "w:footnoteReference", // 9: Footnotes
      "w:ins ",              // 10: Track changes - insertions
    ];

    for (const marker of markers) {
      if (docXml.includes(marker)) return true;
    }

    // Check multi-column layout
    const colsMatch = docXml.match(/<w:cols[^>]*num="(\d+)"/);
    if (colsMatch && parseInt(colsMatch[1], 10) > 1) return true;

    // Check image references from .rels file
    try {
      const relsXml = execSync(
        `unzip -p "${filePath}" word/_rels/document.xml.rels`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 },
      );
      if (relsXml.includes('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"')) {
        return true;
      }
    } catch {
      // No rels file — that's fine
    }

    return false;
  } catch {
    // If we can't read the XML, assume complex → vlm (fail-safe)
    return true;
  }
}

// ============================================================================
// Docx processing
// ============================================================================

// ============================================================================
// Xlsx complexity auto-detection
// ============================================================================

/** Extract a specific sheet XML from xlsx ZIP */
function extractSheetXml(filePath: string, sheetName: string): string | null {
  try {
    return execSync(
      `unzip -p "${filePath}" xl/worksheets/${sheetName}.xml 2>/dev/null`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 },
    );
  } catch {
    return null;
  }
}

/** Check if an .xlsx file is complex (has formulas, charts, images, pivot tables, multi-sheet, etc.)
 *  by reading its internal XML structure and ZIP directory. Returns true if ANY complexity marker is found. */
function isXlsxComplex(filePath: string): boolean {
  try {
    // 1. Formula cells: <f> or <f ...> tags in sheet XML
    const sheet1Xml = extractSheetXml(filePath, "sheet1") ?? extractSheetXml(filePath, "sheet");
    if (sheet1Xml && /<f[\s>]/.test(sheet1Xml)) return true;

    // 2-5. Special directories: charts, drawings, pivot tables, pivot caches
    const fileList = execSync(
      `unzip -l "${filePath}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1 * 1024 * 1024 },
    );
    if (/xl\/charts\//.test(fileList)) return true;
    if (/xl\/drawings\//.test(fileList)) return true;
    if (/xl\/pivotTables\//.test(fileList)) return true;
    if (/xl\/pivotCache\//.test(fileList)) return true;

    // 6. Multiple sheets
    try {
      const workbookXml = execSync(
        `unzip -p "${filePath}" xl/workbook.xml`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1 * 1024 * 1024 },
      );
      const sheetCount = (workbookXml.match(/<sheet\s/g) || []).length;
      if (sheetCount > 1) return true;
    } catch {
      // No workbook.xml — just continue checking other markers
    }

    // 7-9. Conditional formatting, data validation in sheet
    if (sheet1Xml) {
      if (sheet1Xml.includes("<conditionalFormatting")) return true;
      if (sheet1Xml.includes("<dataValidation")) return true;
      // 10. Large dataset (>500 rows)
      const rowCount = (sheet1Xml.match(/<row\s/g) || []).length;
      if (rowCount > 500) return true;
    }

    return false;
  } catch {
    // Fail-safe: can't read XML → assume complex → vlm
    return true;
  }
}

// ============================================================================
// Pptx complexity auto-detection
// ============================================================================

/** Check if a .pptx file is complex (has charts, media, diagrams, animations, embedded objects, etc.)
 *  by reading its internal ZIP structure. Returns true if ANY complexity marker is found. */
function isPptxComplex(filePath: string): boolean {
  try {
    // Get full ZIP file listing
    const fileList = execSync(
      `unzip -l "${filePath}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024 },
    );

    // 1. Charts
    if (/ppt\/charts\//.test(fileList)) return true;

    // 2. Lots of media (>5 files in ppt/media/)
    const mediaCount = (fileList.match(/ppt\/media\//g) || []).length;
    if (mediaCount > 5) return true;

    // 3. SmartArt / diagrams
    if (/ppt\/diagrams\//.test(fileList)) return true;

    // 4. OLE embedded objects
    if (/ppt\/embeddings\//.test(fileList)) return true;

    // 9. Speaker notes (notesSlides with actual content)
    if (/ppt\/notesSlides\//.test(fileList)) return true;

    // 9. Slide count > 20
    const slideCount = (fileList.match(/ppt\/slides\/slide\d+\.xml/g) || []).length;
    if (slideCount > 20) return true;

    // Read first slide XML for per-slide markers
    try {
      const slide1Xml = execSync(
        `unzip -p "${filePath}" ppt/slides/slide1.xml`,
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 },
      );

      // 5. OLE objects in slide content
      if (/<p:oleObj/.test(slide1Xml)) return true;

      // 6. Embedded tables
      if (/<a:tbl[\s>]/.test(slide1Xml)) return true;

      // 7. Animations/transitions
      if (/<p:anim/.test(slide1Xml)) return true;

      // 8. Embedded video or audio
      if (/<p:video|audioFile/.test(slide1Xml)) return true;
    } catch {
      // No slide1.xml — that's fine, continue
    }

    return false;
  } catch {
    // Fail-safe: can't read ZIP → assume complex → vlm
    return true;
  }
}

const SUPPORTED_DOC_EXTS = new Set([".doc", ".docx"]);

async function processDocx(
  filePath: string,
  embedder: Embedder,
  chunkConfig: { maxTokens: number; overlapTokens: number; strategy: string },
  pdfConfig: NonNullable<IngesterConfig["pdfParser"]>,
): Promise<KBEntry[]> {
  const base = basename(filePath);
  const fileHash = await hashFile(filePath);

  // Auto-detect complexity from XML
  const complex = isDocxComplex(filePath);
  const modelVersion = complex ? "vlm" : "pipeline";
  console.log(`[Ark KB] Docx complexity: ${complex ? "complex→vlm" : "simple→pipeline"} (${base})`);

  const text = await extractPdfMinerU(filePath, pdfConfig, { modelVersion });
  const chunks = chunkText(text, chunkConfig);
  const now = Date.now();

  if (chunks.length === 0) {
    const vectors = await embedder.embed(`[DOCX:${base}]`);
    return [
      {
        id: `${base}_0_${now}`,
        chunk_text: `[DOCX: ${base}]`,
        vector: vectors[0],
        source_path: base,
        chunk_index: 0,
        total_chunks: 1,
        images: "[]",
        file_type: "docx",
        file_hash: fileHash,
        created_at: now,
        updated_at: now,
      },
    ];
  }

  const vectors = await embedder.embed(chunks);

  return chunks.map((chunk_text, i) => ({
    id: `${base}_${i}_${now}`,
    chunk_text: chunk_text.substring(0, 2000),
    vector: vectors[i],
    source_path: base,
    chunk_index: i,
    total_chunks: chunks.length,
    images: "[]",
    file_type: "docx",
    file_hash: fileHash,
    created_at: now,
    updated_at: now,
  }));
}

async function processDoc(
  filePath: string,
  embedder: Embedder,
  chunkConfig: { maxTokens: number; overlapTokens: number; strategy: string },
  pdfConfig: NonNullable<IngesterConfig["pdfParser"]>,
): Promise<KBEntry[]> {
  const base = basename(filePath);
  const fileHash = await hashFile(filePath);

  // .doc is binary — always use vlm
  console.log(`[Ark KB] Doc file: always→vlm (${base})`);
  const text = await extractPdfMinerU(filePath, pdfConfig, { modelVersion: "vlm" });
  const chunks = chunkText(text, chunkConfig);
  const now = Date.now();

  if (chunks.length === 0) {
    const vectors = await embedder.embed(`[DOC:${base}]`);
    return [
      {
        id: `${base}_0_${now}`,
        chunk_text: `[DOC: ${base}]`,
        vector: vectors[0],
        source_path: base,
        chunk_index: 0,
        total_chunks: 1,
        images: "[]",
        file_type: "doc",
        file_hash: fileHash,
        created_at: now,
        updated_at: now,
      },
    ];
  }

  const vectors = await embedder.embed(chunks);

  return chunks.map((chunk_text, i) => ({
    id: `${base}_${i}_${now}`,
    chunk_text: chunk_text.substring(0, 2000),
    vector: vectors[i],
    source_path: base,
    chunk_index: i,
    total_chunks: chunks.length,
    images: "[]",
    file_type: "doc",
    file_hash: fileHash,
    created_at: now,
    updated_at: now,
  }));
}

// ============================================================================
// Xlsx processing
// ============================================================================

async function processXlsx(
  filePath: string,
  embedder: Embedder,
  chunkConfig: { maxTokens: number; overlapTokens: number; strategy: string },
  pdfConfig: NonNullable<IngesterConfig["pdfParser"]>,
): Promise<KBEntry[]> {
  const base = basename(filePath);
  const fileHash = await hashFile(filePath);

  // Auto-detect complexity from XML
  const complex = isXlsxComplex(filePath);
  const modelVersion = complex ? "vlm" : "pipeline";
  console.log(`[Ark KB] Xlsx complexity: ${complex ? "complex→vlm" : "simple→pipeline"} (${base})`);

  const text = await extractPdfMinerU(filePath, pdfConfig, { modelVersion });
  const chunks = chunkText(text, chunkConfig);
  const now = Date.now();

  if (chunks.length === 0) {
    const vectors = await embedder.embed(`[XLSX:${base}]`);
    return [
      {
        id: `${base}_0_${now}`,
        chunk_text: `[XLSX: ${base}]`,
        vector: vectors[0],
        source_path: base,
        chunk_index: 0,
        total_chunks: 1,
        images: "[]",
        file_type: "xlsx",
        file_hash: fileHash,
        created_at: now,
        updated_at: now,
      },
    ];
  }

  const vectors = await embedder.embed(chunks);

  return chunks.map((chunk_text, i) => ({
    id: `${base}_${i}_${now}`,
    chunk_text: chunk_text.substring(0, 2000),
    vector: vectors[i],
    source_path: base,
    chunk_index: i,
    total_chunks: chunks.length,
    images: "[]",
    file_type: "xlsx",
    file_hash: fileHash,
    created_at: now,
    updated_at: now,
  }));
}

async function processXls(
  filePath: string,
  embedder: Embedder,
  chunkConfig: { maxTokens: number; overlapTokens: number; strategy: string },
  pdfConfig: NonNullable<IngesterConfig["pdfParser"]>,
): Promise<KBEntry[]> {
  const base = basename(filePath);
  const fileHash = await hashFile(filePath);

  // .xls is binary — always use vlm (same as .doc)
  console.log(`[Ark KB] Xls file: always→vlm (${base})`);
  const text = await extractPdfMinerU(filePath, pdfConfig, { modelVersion: "vlm" });
  const chunks = chunkText(text, chunkConfig);
  const now = Date.now();

  if (chunks.length === 0) {
    const vectors = await embedder.embed(`[XLS:${base}]`);
    return [
      {
        id: `${base}_0_${now}`,
        chunk_text: `[XLS: ${base}]`,
        vector: vectors[0],
        source_path: base,
        chunk_index: 0,
        total_chunks: 1,
        images: "[]",
        file_type: "xls",
        file_hash: fileHash,
        created_at: now,
        updated_at: now,
      },
    ];
  }

  const vectors = await embedder.embed(chunks);

  return chunks.map((chunk_text, i) => ({
    id: `${base}_${i}_${now}`,
    chunk_text: chunk_text.substring(0, 2000),
    vector: vectors[i],
    source_path: base,
    chunk_index: i,
    total_chunks: chunks.length,
    images: "[]",
    file_type: "xls",
    file_hash: fileHash,
    created_at: now,
    updated_at: now,
  }));
}

// ============================================================================
// Pptx processing
// ============================================================================

async function processPptx(
  filePath: string,
  embedder: Embedder,
  chunkConfig: { maxTokens: number; overlapTokens: number; strategy: string },
  pdfConfig: NonNullable<IngesterConfig["pdfParser"]>,
): Promise<KBEntry[]> {
  const base = basename(filePath);
  const fileHash = await hashFile(filePath);

  // Auto-detect complexity from ZIP structure
  const complex = isPptxComplex(filePath);
  const modelVersion = complex ? "vlm" : "pipeline";
  console.log(`[Ark KB] Pptx complexity: ${complex ? "complex→vlm" : "simple→pipeline"} (${base})`);

  const text = await extractPdfMinerU(filePath, pdfConfig, { modelVersion });
  const chunks = chunkText(text, chunkConfig);
  const now = Date.now();

  if (chunks.length === 0) {
    const vectors = await embedder.embed(`[PPTX:${base}]`);
    return [
      {
        id: `${base}_0_${now}`,
        chunk_text: `[PPTX: ${base}]`,
        vector: vectors[0],
        source_path: base,
        chunk_index: 0,
        total_chunks: 1,
        images: "[]",
        file_type: "pptx",
        file_hash: fileHash,
        created_at: now,
        updated_at: now,
      },
    ];
  }

  const vectors = await embedder.embed(chunks);

  return chunks.map((chunk_text, i) => ({
    id: `${base}_${i}_${now}`,
    chunk_text: chunk_text.substring(0, 2000),
    vector: vectors[i],
    source_path: base,
    chunk_index: i,
    total_chunks: chunks.length,
    images: "[]",
    file_type: "pptx",
    file_hash: fileHash,
    created_at: now,
    updated_at: now,
  }));
}

async function processPpt(
  filePath: string,
  embedder: Embedder,
  chunkConfig: { maxTokens: number; overlapTokens: number; strategy: string },
  pdfConfig: NonNullable<IngesterConfig["pdfParser"]>,
): Promise<KBEntry[]> {
  const base = basename(filePath);
  const fileHash = await hashFile(filePath);

  // .ppt is binary — always use vlm (same as .doc / .xls)
  console.log(`[Ark KB] Ppt file: always→vlm (${base})`);
  const text = await extractPdfMinerU(filePath, pdfConfig, { modelVersion: "vlm" });
  const chunks = chunkText(text, chunkConfig);
  const now = Date.now();

  if (chunks.length === 0) {
    const vectors = await embedder.embed(`[PPT:${base}]`);
    return [
      {
        id: `${base}_0_${now}`,
        chunk_text: `[PPT: ${base}]`,
        vector: vectors[0],
        source_path: base,
        chunk_index: 0,
        total_chunks: 1,
        images: "[]",
        file_type: "ppt",
        file_hash: fileHash,
        created_at: now,
        updated_at: now,
      },
    ];
  }

  const vectors = await embedder.embed(chunks);

  return chunks.map((chunk_text, i) => ({
    id: `${base}_${i}_${now}`,
    chunk_text: chunk_text.substring(0, 2000),
    vector: vectors[i],
    source_path: base,
    chunk_index: i,
    total_chunks: chunks.length,
    images: "[]",
    file_type: "ppt",
    file_hash: fileHash,
    created_at: now,
    updated_at: now,
  }));
}

// ============================================================================
// HTML processing
// ============================================================================

async function processHtml(
  filePath: string,
  embedder: Embedder,
  chunkConfig: { maxTokens: number; overlapTokens: number; strategy: string },
  pdfConfig: NonNullable<IngesterConfig["pdfParser"]>,
): Promise<KBEntry[]> {
  const base = basename(filePath);
  const fileHash = await hashFile(filePath);

  // HTML always uses MinerU-HTML model for structured extraction
  console.log(`[Ark KB] Html: MinerU-HTML (${base})`);
  const text = await extractPdfMinerU(filePath, pdfConfig, { modelVersion: "MinerU-HTML" });
  const chunks = chunkText(text, chunkConfig);
  const now = Date.now();

  if (chunks.length === 0) {
    const vectors = await embedder.embed(`[HTML:${base}]`);
    return [
      {
        id: `${base}_0_${now}`,
        chunk_text: `[HTML: ${base}]`,
        vector: vectors[0],
        source_path: base,
        chunk_index: 0,
        total_chunks: 1,
        images: "[]",
        file_type: "html",
        file_hash: fileHash,
        created_at: now,
        updated_at: now,
      },
    ];
  }

  const vectors = await embedder.embed(chunks);

  return chunks.map((chunk_text, i) => ({
    id: `${base}_${i}_${now}`,
    chunk_text: chunk_text.substring(0, 2000),
    vector: vectors[i],
    source_path: base,
    chunk_index: i,
    total_chunks: chunks.length,
    images: "[]",
    file_type: "html",
    file_hash: fileHash,
    created_at: now,
    updated_at: now,
  }));
}

// ============================================================================
// Text processing
// ============================================================================

async function processText(
  filePath: string,
  embedder: Embedder,
  chunkConfig: { maxTokens: number; overlapTokens: number; strategy: string },
): Promise<KBEntry[]> {
  const content = await readFile(filePath, "utf-8");
  const base = basename(filePath);
  const fileHash = await hashFile(filePath);
  const chunks = chunkText(content, chunkConfig);
  const now = Date.now();

  if (chunks.length === 0) return [];

  // Batch embed all chunks at once
  const vectors = await embedder.embed(chunks);

  return chunks.map((chunk_text, i) => ({
    id: `${base}_${i}_${now}`,
    chunk_text,
    vector: vectors[i],
    source_path: base,
    chunk_index: i,
    total_chunks: chunks.length,
    images: "[]",
    file_type: extname(filePath).slice(1),
    file_hash: fileHash,
    created_at: now,
    updated_at: now,
  }));
}

// ============================================================================
// Image processing
// ============================================================================

async function processImage(
  filePath: string,
  embedder: Embedder,
  opts?: { imageConfig?: { endpoint: string; apiKey: string; timeoutMs: number }; method?: "text" | "multimodal" },
): Promise<KBEntry[]> {
  const base = basename(filePath);
  const fileHash = await hashFile(filePath);
  const now = Date.now();
  const method = opts?.method ?? "text";

  // Text mode: VLM summary → text embedding
  if (method === "text" && opts?.imageConfig?.apiKey) {
    console.log(`[Ark KB] Image text mode: summarizing ${base} via VLM…`);
    try {
      const summary = await summarizeImage(filePath, {
        apiKey: opts.imageConfig.apiKey,
        endpoint: opts.imageConfig.endpoint,
        timeoutMs: opts.imageConfig.timeoutMs ?? 60000,
      });
      const chunks = chunkText(summary, { maxTokens: 400, overlapTokens: 50, strategy: "paragraph" });
      if (chunks.length === 0) chunks.push(summary);
      const vectors = await embedder.embed(chunks);
      return chunks.map((text, i) => ({
        id: `${base}_${i}_${now}`,
        chunk_text: text,
        vector: vectors[i],
        source_path: base,
        chunk_index: i,
        total_chunks: chunks.length,
        images: JSON.stringify([base]),
        file_type: extname(filePath).slice(1),
        file_hash: fileHash,
        created_at: now,
        updated_at: now,
      }));
    } catch (err: any) {
      console.error("[Ark KB] Image summary failed for " + filePath + ": " + err.message);
      // Fall through to filename-only embedding
    }
  }

  // Multimodal mode (or fallback): direct multimodal embedding
  console.log(`[Ark KB] Image mm/fallback mode: embedding ${base} directly`);
  const mediaData = await exposeMediaFile(dirname(filePath), basename(filePath));
  const vectors = await embedder.embed([mediaData || basename(filePath)]);

  return [
    {
      id: `${base}_0_${now}`,
      chunk_text: `[Image: ${base}]`,
      vector: vectors[0],
      source_path: base,
      chunk_index: 0,
      total_chunks: 1,
      images: JSON.stringify([base]),
      file_type: extname(filePath).slice(1),
      file_hash: fileHash,
      created_at: now,
      updated_at: now,
    },
  ];
}

// ============================================================================
// Video processing
// ============================================================================

async function processVideo(
  filePath: string,
  embedder: Embedder,
  vlmConfig: { endpoint: string; apiKey: string; maxFrames: number; timeoutMs?: number },
  method: "text" | "multimodal" = "text",
): Promise<KBEntry[]> {
  const base = basename(filePath);
  const fileHash = await hashFile(filePath);
  const now = Date.now();

  const summarize = vlmConfig.apiKey && vlmConfig.endpoint;

  if (!summarize) {
    console.log("[Ark KB] Video summarizer not configured, embedding filename only");
    const vectors = await embedder.embed([basename(filePath)]);
    return [{
      id: base + "_0_" + now,
      chunk_text: "[Video: " + base + "]",
      vector: vectors[0],
      source_path: base,
      chunk_index: 0,
      total_chunks: 1,
      images: "[]",
      file_type: extname(filePath).slice(1),
      file_hash: fileHash,
      created_at: now,
      updated_at: now,
    }];
  }

  // Multimodal mode: pass video file directly to embedding model (model must support video)
  if (method === "multimodal") {
    try {
      const videoData = await exposeMediaFile(dirname(filePath), basename(filePath));
      if (!videoData) throw new Error("Failed to expose video file");
      const vectors = await embedder.embed([videoData]);
      return [{
        id: `${base}_0_${now}`,
        chunk_text: `[Video: ${base}]`,
        vector: vectors[0],
        source_path: base,
        chunk_index: 0,
        total_chunks: 1,
        images: "[]",
        file_type: extname(filePath).slice(1),
        file_hash: fileHash,
        created_at: now,
        updated_at: now,
      }];
    } catch (err: any) {
      console.error("[Ark KB] Video multimodal embedding failed for " + filePath + ": " + err.message);
      // Fall through to filename-only
    }
  }

  try {
    const result = await summarizeVideo(filePath, {
      apiKey: vlmConfig.apiKey,
      endpoint: vlmConfig.endpoint,
      timeoutMs: 120_000,
      maxFrames: vlmConfig.maxFrames ?? 100,
      tileSize: 10,
    });

    const chunks = chunkText(result.summary, { maxTokens: 400, overlapTokens: 50, strategy: "paragraph" });
    if (chunks.length === 0) chunks.push(result.summary);
    const chunkVectors = await embedder.embed(chunks);

    return chunks.map((text, i) => ({
      id: base + "_" + i + "_" + now,
      chunk_text: text,
      vector: chunkVectors[i],
      source_path: base,
      chunk_index: i,
      total_chunks: chunks.length,
      images: "[]",
      file_type: extname(filePath).slice(1),
      file_hash: fileHash,
      created_at: now,
      updated_at: now,
    }));
  } catch (err: any) {
    console.error("[Ark KB] Video summary failed for " + filePath + ": " + err.message);
    const vectors = await embedder.embed([basename(filePath)]);
    return [{
      id: base + "_0_" + now,
      chunk_text: "[Video: " + base + "]",
      vector: vectors[0],
      source_path: base,
      chunk_index: 0,
      total_chunks: 1,
      images: "[]",
      file_type: extname(filePath).slice(1),
      file_hash: fileHash,
      created_at: now,
      updated_at: now,
    }];
  }
}


// ============================================================================
// PDF processing
// ============================================================================

async function processPdf(
  filePath: string,
  embedder: Embedder,
  chunkConfig: { maxTokens: number; overlapTokens: number; strategy: string },
  pdfConfig: NonNullable<IngesterConfig["pdfParser"]>,
): Promise<KBEntry[]> {
  const base = basename(filePath);
  const fileHash = await hashFile(filePath);
  const text = await extractPdfText(filePath, pdfConfig);
  const chunks = chunkText(text, chunkConfig);
  const now = Date.now();

  if (chunks.length === 0) {
    // Empty PDF — still register it
    const vectors = await embedder.embed(`[PDF:${base}]`);
    return [
      {
        id: `${base}_0_${now}`,
        chunk_text: `[PDF: ${base}]`,
        vector: vectors[0],
        source_path: base,
        chunk_index: 0,
        total_chunks: 1,
        images: "[]",
        file_type: "pdf",
        file_hash: fileHash,
        created_at: now,
        updated_at: now,
      },
    ];
  }

  const vectors = await embedder.embed(chunks);

  return chunks.map((chunk_text, i) => ({
    id: `${base}_${i}_${now}`,
    chunk_text: chunk_text.substring(0, 2000), // safety limit
    vector: vectors[i],
    source_path: base,
    chunk_index: i,
    total_chunks: chunks.length,
    images: "[]",
    file_type: "pdf",
    file_hash: fileHash,
    created_at: now,
    updated_at: now,
  }));
}

// ============================================================================
// Ingester
// ============================================================================

export type IngestResult = { entries: number; source: string; skipped: boolean };

export class Ingester {
  private store: KnowledgeStore;
  private embedder: Embedder;
  private config: IngesterConfig;
  private videoConfig = { endpoint: "", apiKey: "", maxFrames: 100, timeoutMs: 120_000 };
  private imageConfig = { endpoint: "", apiKey: "", timeoutMs: 60_000 };
  private imageMethod: "text" | "multimodal" = "text";
  private videoMethod: "text" | "multimodal" = "text";

  private knowledgePath: string = "";

  /** Per-file mutex: prevents TOCTOU races when the same file is ingested concurrently. */
  private _ingestLocks = new Map<string, Promise<IngestResult>>();
  private _hashLocks = new Set<string>(); // Race-condition guard: prevent concurrent ingest of same content

  constructor(
    store: KnowledgeStore,
    embedder: Embedder,
    config: IngesterConfig,
    knowledgePath?: string,
    videoConfig?: { endpoint: string; apiKey: string; maxFrames: number; timeoutMs?: number },
    imageConfig?: { endpoint: string; apiKey: string; timeoutMs: number },
    modes?: { imageMethod?: "text" | "multimodal"; videoMethod?: "text" | "multimodal" },
  ) {
    this.store = store;
    this.embedder = embedder;
    this.config = config;
    if (knowledgePath) this.knowledgePath = knowledgePath;
    if (videoConfig) this.videoConfig = { ...this.videoConfig, ...videoConfig };
    if (imageConfig) this.imageConfig = { ...this.imageConfig, ...imageConfig };
    if (modes) {
      this.imageMethod = modes.imageMethod ?? "text";
      this.videoMethod = modes.videoMethod ?? "text";
    }
  }

  /**
   * Ingest a single file: detect type → hash → chunk → embed → upsert.
   * Skips files with no changes (hash comparison).
   * Returns the number of entries inserted.
   */
  async ingestFile(filePath: string): Promise<IngestResult> {
    // Mutex guard: if this file is already being ingested, await the in-flight promise.
    if (this._ingestLocks.has(filePath)) {
      return await this._ingestLocks.get(filePath)!;
    }

    const promise = (async (): Promise<IngestResult> => {
      let hashLock: string | null = null;
      try {
        const kind = detectFileKind(filePath);
        if (kind === "unsupported") {
          console.log(`[Ark KB] Skipping unsupported file: ${filePath}`);
          return { entries: 0, source: basename(filePath), skipped: true };
        }

        // Check if the embedding model supports this file type
        const modality = (kind === "pdf" || kind === "doc" || kind === "docx" || kind === "xls" || kind === "xlsx" || kind === "ppt" || kind === "pptx" || kind === "html") ? "text" : kind; // PDFs are text after MinerU extraction
        const videoTextMode = kind === "video" && this.videoConfig.apiKey && this.videoMethod === "text"; // Text-mode video: VLM summary → text
        const videoMMMode = kind === "video" && this.videoMethod === "multimodal"; // Multimodal video: direct frame embedding
        const imageTextMode = kind === "image" && this.imageConfig.apiKey && this.imageMethod === "text"; // Text-mode image: VLM summary → text
        const skipModalityCheck = videoTextMode || videoMMMode || imageTextMode; // VLM summary path bypasses embedding model modality check
        if (!skipModalityCheck && !this.embedder.supportsModality(modality)) {
          console.log(`[Ark KB] Skipping ${kind} file (model does not support ${modality}): ${filePath}`);
          return { entries: 0, source: basename(filePath), skipped: true };
        }

        const base = basename(filePath);

        // Third layer: DB hash deduplication (different name, same content)
        try {
          const newHash = await hashFile(filePath);

          // Hash-level lock: prevent concurrent ingestion of same content with different file names
          if (this._hashLocks.has(newHash)) {
            console.log(`[Ark KB] Skipping duplicate (hash already being ingested): ${base}`);
            return { entries: 0, source: relative(this.knowledgePath, filePath), skipped: true };
          }

          const hashExists = await this.store.hasFileHash(newHash);
          if (hashExists) {
            console.log(`[Ark KB] Skipping duplicate (hash match): ${base}`);
            return { entries: 0, source: relative(this.knowledgePath, filePath), skipped: true };
          }

          // Lock this hash NOW, before the expensive PDF/video processing starts
          // This prevents the race condition where file2's hash check passes before file1's insert commits
          hashLock = newHash;
          this._hashLocks.add(newHash);
        } catch {
          // Continue with ingestion if hash check fails
        }

        let entries: KBEntry[];
        try {
          switch (kind) {
            case "text":
              entries = await processText(
                filePath,
                this.embedder,
                this.config.chunking,
              );
              break;
            case "image":
              entries = await processImage(filePath, this.embedder, {
                imageConfig: this.imageConfig,
                method: this.imageMethod,
              });
              break;
            case "video":
              entries = await processVideo(filePath, this.embedder, this.videoConfig, this.videoMethod);
              break;
            case "pdf":
              entries = await processPdf(
                filePath,
                this.embedder,
                this.config.chunking,
                this.config.pdfParser!,
              );
              break;
            case "docx":
              entries = await processDocx(
                filePath,
                this.embedder,
                this.config.chunking,
                this.config.pdfParser!,
              );
              break;
            case "xlsx":
              entries = await processXlsx(
                filePath,
                this.embedder,
                this.config.chunking,
                this.config.pdfParser!,
              );
              break;
            case "xls":
              entries = await processXls(
                filePath,
                this.embedder,
                this.config.chunking,
                this.config.pdfParser!,
              );
              break;
            case "pptx":
              entries = await processPptx(
                filePath,
                this.embedder,
                this.config.chunking,
                this.config.pdfParser!,
              );
              break;
            case "ppt":
              entries = await processPpt(
                filePath,
                this.embedder,
                this.config.chunking,
                this.config.pdfParser!,
              );
              break;
            case "doc":
              entries = await processDoc(
                filePath,
                this.embedder,
                this.config.chunking,
                this.config.pdfParser!,
              );
              break;
            case "html":
              entries = await processHtml(
                filePath,
                this.embedder,
                this.config.chunking,
                this.config.pdfParser!,
              );
              break;
            default:
              return { entries: 0, source: relative(this.knowledgePath, filePath), skipped: true };
          }
        } catch (err: any) {
          console.error(`[Ark KB] Failed to process ${filePath}: ${err.message}`);
          return { entries: 0, source: relative(this.knowledgePath, filePath), skipped: false };
        }

        if (entries.length === 0) {
          return { entries: 0, source: relative(this.knowledgePath, filePath), skipped: false };
        }

        // Fix source_path to be relative to knowledgePath (for multi-KB media resolution)
        const relativePath = relative(this.knowledgePath, filePath);
        entries = entries.map((e: any) => ({ ...e, source_path: relativePath }));

        // Insert new entries first (crash-safe: new data is persisted before old is removed)
        await this.store.insert(entries);
        // Clean up old entries after new data is safely stored
        await this.store.deleteBySource(base);
        console.log(`[Ark KB] Indexed: ${base} (${entries.length} chunks)`);

        return { entries: entries.length, source: relativePath, skipped: false };
      } finally {
        this._ingestLocks.delete(filePath);
        if (hashLock) this._hashLocks.delete(hashLock);
      }
    })();

    this._ingestLocks.set(filePath, promise);
    return await promise;
  }

  /**
   * Recursively ingest all supported files in a directory.
   */
  /** Scan knowledge dir and re-ingest only files missing from LanceDB or with changed hash */
  async heal(dirPath: string): Promise<{ healed: number; skipped: number }> {
    let healed = 0;
    let skipped = 0;

    const sources = await this.store.listSources();
    const files = await walkDir(dirPath);

    for (const filePath of files) {
      try {
        const base = basename(filePath);
        const fileHash = await hashFile(filePath);

        // Check if this file with same hash already exists in LanceDB
        // Hash-based dedup: O(1) check instead of BM25 filename search
        if (await this.store.hasFileHash(fileHash)) {
          skipped++;
          continue; // Already indexed, skip
        }

        // File is new or changed — ingest it
        const result = await this.ingestFile(filePath);
        if (result.entries > 0) healed++;
      } catch (err: any) {
        console.error(`[Ark KB] Heal error for ${filePath}: ${err.message}`);
      }
    }

    return { healed, skipped };
  }

  /** Scan and ingest all files in a directory (unconditional). */
  async ingestDirectory(dirPath: string): Promise<{ total: number; files: number; errors: number }> {
    let totalEntries = 0;
    let totalFiles = 0;
    let errorCount = 0;

    const files = await walkDir(dirPath);

    for (const filePath of files) {
      try {
        const result = await this.ingestFile(filePath);
        if (result.entries > 0) {
          totalEntries += result.entries;
          totalFiles++;
        }
      } catch (err: any) {
        console.error(`[Ark KB] Ingest error for ${filePath}: ${err.message}`);
        errorCount++;
      }
    }

    return { total: totalEntries, files: totalFiles, errors: errorCount };
  }
}

// ============================================================================
// Directory walker
// ============================================================================

async function walkDir(dirPath: string, ignorePatterns?: string[]): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      // Skip hidden directories
      if (entry.name.startsWith(".")) continue;
      const subResults = await walkDir(fullPath, ignorePatterns);
      results.push(...subResults);
    } else if (entry.isFile()) {
      if (ignorePatterns && matchesIgnore(entry.name, ignorePatterns)) continue;
      const kind = detectFileKind(fullPath);
      if (kind !== "unsupported") {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function matchesIgnore(filename: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1);
      if (filename.endsWith(ext)) return true;
    } else if (pattern.startsWith("~") && filename.startsWith("~")) {
      return true;
    } else if (pattern.startsWith(".*") && filename.startsWith(".")) {
      return true;
    } else if (pattern === ".*" && filename.startsWith(".")) {
      return true;
    }
  }
  return false;
}
