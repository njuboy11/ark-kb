/**
 * Ark KB — Ingester
 * File ingestion: detect type → hash → chunk → embed → upsert into store.
 * Handles text, images, and PDFs with configurable chunking.
 */
import { readFile, readdir } from "node:fs/promises";
import { extname, basename, join } from "node:path";
import { createHash } from "node:crypto";
import { exposeMediaFile } from "./embedder.js";
import { summarizeVideo, summarizeImage } from "./video.js";
import { dirname } from "node:path";
// ============================================================================
// File type detection
// ============================================================================
const SUPPORTED_TEXT_EXTS = new Set([
    ".md", ".txt", ".csv", ".html", ".htm",
    ".json", ".yaml", ".yml", ".xml",
    ".py", ".js", ".ts", ".jsx", ".tsx",
    ".java", ".c", ".cpp", ".h", ".go",
    ".rs", ".rb", ".php", ".sh", ".bash",
    ".sql", ".r", ".scala", ".lua", ".toml",
]);
const SUPPORTED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".jfif", ".webp", ".gif", ".bmp", ".svg", ".tiff", ".tif", ".ico", ".heic", ".heif", ".raw", ".cr2", ".nef", ".arw"]);
const SUPPORTED_VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".wmv", ".flv", ".m4v", ".3gp", ".ogv", ".ts"]);
export function detectFileKind(filePath) {
    const ext = extname(filePath).toLowerCase();
    if (SUPPORTED_TEXT_EXTS.has(ext))
        return "text";
    if (SUPPORTED_IMAGE_EXTS.has(ext))
        return "image";
    if (SUPPORTED_VIDEO_EXTS.has(ext))
        return "video";
    if (ext === ".pdf")
        return "pdf";
    return "unsupported";
}
// ============================================================================
// Content hashing
// ============================================================================
export async function hashFile(filePath) {
    const content = await readFile(filePath);
    return createHash("sha256").update(content).digest("hex");
}
// ============================================================================
// Chunking strategies
// ============================================================================
/**
 * Split text into chunks using the configured strategy.
 * Tokens are approximated as chars for CJK text.
 */
export function chunkText(text, config) {
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
function chunkByParagraph(text, maxTokens, overlapTokens) {
    // Split on blank lines (paragraph boundary)
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    const chunks = [];
    let current = "";
    const overlap = overlapTokens;
    for (const para of paragraphs) {
        if (current.length + para.length > maxTokens && current.length > 0) {
            chunks.push(current.trim());
            // Keep last overlap chars as context carryover
            current = current.slice(-overlap) + "\n\n" + para;
        }
        else {
            current += (current.length > 0 ? "\n\n" : "") + para;
        }
    }
    if (current.trim().length > 0) {
        chunks.push(current.trim());
    }
    return chunks;
}
function chunkFixed(text, maxTokens, overlapTokens) {
    const chunks = [];
    let start = 0;
    const overlap = overlapTokens;
    while (start < text.length) {
        const end = start + maxTokens;
        chunks.push(text.slice(start, end));
        start = end - overlap;
        if (start >= text.length)
            break;
    }
    return chunks;
}
function chunkBySentence(text, maxTokens, overlapTokens) {
    // Split on sentence-ending punctuation (handles CJK and western)
    const sentences = text.split(/(?<=[。！？.!?])\s*/).filter(s => s.trim().length > 0);
    const chunks = [];
    let current = "";
    const overlap = overlapTokens;
    for (const sentence of sentences) {
        if (current.length + sentence.length > maxTokens && current.length > 0) {
            chunks.push(current.trim());
            current = current.slice(-overlap) + sentence;
        }
        else {
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
export async function extractPdfText(filePath, pdfConfig) {
    if (pdfConfig.api === "mineru" && pdfConfig.endpoint) {
        return await extractPdfMinerU(filePath, pdfConfig);
    }
    // Built-in pdf-parse fallback (v1.x loaded via createRequire for ESM compat)
    try {
        const { createRequire } = await import("node:module");
        const _require = createRequire(import.meta.url);
        const pdfParse = _require("pdf-parse");
        const dataBuffer = await readFile(filePath);
        const data = await pdfParse(dataBuffer);
        return data.text || "";
    }
    catch (err) {
        throw new Error(`PDF parsing failed for ${filePath}: both MinerU and pdf-parse are unavailable. ${err.message}`);
    }
}
async function extractPdfMinerU(filePath, config) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    // Step 0: Expose PDF as a URL (MinerU prefers URL over base64 for large files)
    let pdfUrl;
    const serveDir = "/var/www/downloads";
    if (fs.existsSync(serveDir)) {
        const fileName = path.basename(filePath);
        const dest = path.join(serveDir, fileName);
        fs.copyFileSync(filePath, dest);
        fs.chmodSync(dest, 0o644);
        pdfUrl = `https://home.sfunds.cn:8444/${encodeURIComponent(fileName)}`;
    }
    else {
        // No nginx — fallback to base64 for small files (<2MB)
        const stat = fs.statSync(filePath);
        if (stat.size > 2 * 1024 * 1024) {
            throw new Error("PDF too large for base64 (>2MB) and no HTTP server available. Install nginx or use builtin parser.");
        }
        const fileBuffer = fs.readFileSync(filePath);
        pdfUrl = fileBuffer.toString("base64");
    }
    // Merge user params with sensible defaults
    const submitBody = {
        enable_formula: true,
        enable_table: true,
        ...(config.params ?? {}),
    };
    // Use url or file depending on what we generated
    if (pdfUrl.startsWith("https://")) {
        submitBody.url = pdfUrl;
    }
    else {
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
    const submitData = await submitRes.json();
    if (submitData.code !== 0) {
        throw new Error(`MinerU submit failed: ${submitData.msg || JSON.stringify(submitData)}`);
    }
    const taskId = submitData.data?.task_id;
    if (!taskId)
        throw new Error(`MinerU submit returned no task_id`);
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
        const pollData = await pollRes.json();
        if (pollData.code !== 0) {
            throw new Error(`MinerU poll failed: ${pollData.msg || JSON.stringify(pollData)}`);
        }
        const state = pollData.data?.state;
        if (state === "done") {
            fullZipUrl = pollData.data?.full_zip_url;
            if (!fullZipUrl)
                throw new Error(`MinerU task done but no full_zip_url`);
            break;
        }
        if (state === "failed") {
            throw new Error(`MinerU task failed: ${pollData.data?.err_msg || "unknown"}`);
        }
        console.log(`[Ark KB] MinerU polling ${taskId.slice(0, 8)}... state=${state} (${Math.round((Date.now() - startTime) / 1000)}s)`);
    }
    if (!fullZipUrl) {
        throw new Error(`MinerU task ${taskId} timed out after ${timeoutMs / 1000}s`);
    }
    // Step 3: Download and extract full.md
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ark-mineru-"));
    const zipPath = path.join(tmpDir, "result.zip");
    try {
        const zipRes = await fetch(fullZipUrl);
        if (!zipRes.ok)
            throw new Error(`MinerU download error (${zipRes.status})`);
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
    }
    finally {
        // Cleanup temp directory
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
        catch { /* ignore */ }
    }
}
async function extractPdfBuiltin(filePath) {
    // Fallback: read raw bytes and extract visible ASCII text
    const content = await readFile(filePath);
    const text = content.toString("latin1");
    // Very rough extraction — just grab printable ASCII strings > 10 chars
    const matches = text.match(/[\x20-\x7E\n\r]{10,}/g) || [];
    return matches.join("\n");
}
// ============================================================================
// Text processing
// ============================================================================
async function processText(filePath, embedder, chunkConfig) {
    const content = await readFile(filePath, "utf-8");
    const base = basename(filePath);
    const fileHash = await hashFile(filePath);
    const chunks = chunkText(content, chunkConfig);
    const now = Date.now();
    if (chunks.length === 0)
        return [];
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
async function processImage(filePath, embedder, opts) {
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
            if (chunks.length === 0)
                chunks.push(summary);
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
        }
        catch (err) {
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
async function processVideo(filePath, embedder, vlmConfig, method = "text") {
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
            if (!videoData)
                throw new Error("Failed to expose video file");
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
        }
        catch (err) {
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
        if (chunks.length === 0)
            chunks.push(result.summary);
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
    }
    catch (err) {
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
async function processPdf(filePath, embedder, chunkConfig, pdfConfig) {
    const base = basename(filePath);
    const fileHash = await hashFile(filePath);
    const text = await extractPdfText(filePath, pdfConfig);
    const chunks = chunkText(text, chunkConfig);
    const now = Date.now();
    if (chunks.length === 0) {
        // Empty PDF — still register it
        const vectors = await embedder.embed(`[PDF:${filePath}]`);
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
export class Ingester {
    store;
    embedder;
    config;
    videoConfig = { endpoint: "", apiKey: "", maxFrames: 100, timeoutMs: 120_000 };
    imageConfig = { endpoint: "", apiKey: "", timeoutMs: 60_000 };
    imageMethod = "text";
    videoMethod = "text";
    constructor(store, embedder, config, videoConfig, imageConfig, modes) {
        this.store = store;
        this.embedder = embedder;
        this.config = config;
        if (videoConfig)
            this.videoConfig = { ...this.videoConfig, ...videoConfig };
        if (imageConfig)
            this.imageConfig = { ...this.imageConfig, ...imageConfig };
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
    async ingestFile(filePath) {
        const kind = detectFileKind(filePath);
        if (kind === "unsupported") {
            console.log(`[Ark KB] Skipping unsupported file: ${filePath}`);
            return { entries: 0, source: basename(filePath), skipped: true };
        }
        // Check if the embedding model supports this file type
        const modality = kind === "pdf" ? "text" : kind; // PDFs are text after MinerU extraction
        const videoTextMode = kind === "video" && this.videoConfig.apiKey && this.videoMethod === "text"; // Text-mode video: VLM summary → text
        const videoMMMode = kind === "video" && this.videoMethod === "multimodal"; // Multimodal video: direct frame embedding
        const skipModalityCheck = videoTextMode || videoMMMode; // Videos always proceed (text mode via VLM, mm mode via frames)
        if (!skipModalityCheck && !this.embedder.supportsModality(modality)) {
            console.log(`[Ark KB] Skipping ${kind} file (model does not support ${modality}): ${filePath}`);
            return { entries: 0, source: basename(filePath), skipped: true };
        }
        const base = basename(filePath);
        // Third layer: DB hash deduplication (different name, same content)
        try {
            const newHash = await hashFile(filePath);
            const hashExists = await this.store.hasFileHash(newHash);
            if (hashExists) {
                console.log(`[Ark KB] Skipping duplicate (hash match): ${base}`);
                return { entries: 0, source: base, skipped: true };
            }
        }
        catch {
            // Continue with ingestion if hash check fails
        }
        let entries;
        try {
            switch (kind) {
                case "text":
                    entries = await processText(filePath, this.embedder, this.config.chunking);
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
                    entries = await processPdf(filePath, this.embedder, this.config.chunking, this.config.pdfParser);
                    break;
                default:
                    return { entries: 0, source: base, skipped: true };
            }
        }
        catch (err) {
            console.error(`[Ark KB] Failed to process ${filePath}: ${err.message}`);
            return { entries: 0, source: base, skipped: false };
        }
        // Delete existing + insert new (only after successful processing)
        await this.store.deleteBySource(base);
        if (entries.length === 0) {
            return { entries: 0, source: base, skipped: false };
        }
        await this.store.insert(entries);
        console.log(`[Ark KB] Indexed: ${base} (${entries.length} chunks)`);
        return { entries: entries.length, source: base, skipped: false };
    }
    /**
     * Recursively ingest all supported files in a directory.
     */
    /** Scan knowledge dir and re-ingest only files missing from LanceDB or with changed hash */
    async heal(dirPath) {
        let healed = 0;
        let skipped = 0;
        const sources = await this.store.listSources();
        const files = await walkDir(dirPath);
        for (const filePath of files) {
            try {
                const base = basename(filePath);
                const fileHash = await hashFile(filePath);
                // Check if this file with same hash already exists in LanceDB
                if (sources.includes(base)) {
                    // Quick check: source exists. For full hash check, we would need a query.
                    // Since we store file_hash per chunk, just check one chunk.
                    const existing = await this.store.searchBM25(base, 1);
                    if (existing.length > 0 && existing[0].entry.file_hash === fileHash) {
                        skipped++;
                        continue; // Already indexed, skip
                    }
                }
                // File is new or changed — ingest it
                const result = await this.ingestFile(filePath);
                if (result.entries > 0)
                    healed++;
            }
            catch (err) {
                console.error(`[Ark KB] Heal error for ${filePath}: ${err.message}`);
            }
        }
        return { healed, skipped };
    }
    /** Scan and ingest all files in a directory (unconditional). */
    async ingestDirectory(dirPath) {
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
            }
            catch (err) {
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
async function walkDir(dirPath, ignorePatterns) {
    const results = [];
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
            // Skip hidden directories
            if (entry.name.startsWith("."))
                continue;
            const subResults = await walkDir(fullPath, ignorePatterns);
            results.push(...subResults);
        }
        else if (entry.isFile()) {
            if (ignorePatterns && matchesIgnore(entry.name, ignorePatterns))
                continue;
            const kind = detectFileKind(fullPath);
            if (kind !== "unsupported") {
                results.push(fullPath);
            }
        }
    }
    return results;
}
function matchesIgnore(filename, patterns) {
    for (const pattern of patterns) {
        if (pattern.startsWith("*.")) {
            const ext = pattern.slice(1);
            if (filename.endsWith(ext))
                return true;
        }
        else if (pattern.startsWith("~") && filename.startsWith("~")) {
            return true;
        }
        else if (pattern.startsWith(".*") && filename.startsWith(".")) {
            return true;
        }
        else if (pattern === ".*" && filename.startsWith(".")) {
            return true;
        }
    }
    return false;
}
//# sourceMappingURL=ingester.js.map