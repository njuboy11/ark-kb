/**
 * Ark KB — Ingester
 * 文件读取、分块、向量化、索引写入
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, basename, join } from "node:path";
import { createHash } from "node:crypto";
// ============================================================================
// Chunking
// ============================================================================
const CHUNK_SIZE = 400; // tokens per chunk
const CHUNK_OVERLAP = 50; // overlap tokens
function chunkText(text) {
    const paragraphs = text.split(/\n\n+/).filter(Boolean);
    const chunks = [];
    let current = "";
    for (const para of paragraphs) {
        const paraLength = para.length; // rough token estimate: chars≈tokens for CJK
        if (current.length + paraLength > CHUNK_SIZE && current.length > 0) {
            chunks.push(current.trim());
            // overlap: keep last CHUNK_OVERLAP chars
            current = current.slice(-CHUNK_OVERLAP) + "\n\n" + para;
        }
        else {
            current += (current ? "\n\n" : "") + para;
        }
    }
    if (current.trim()) {
        chunks.push(current.trim());
    }
    return chunks;
}
// ============================================================================
// File Type Detection
// ============================================================================
const SUPPORTED_TEXT = [".md", ".txt", ".csv"];
const SUPPORTED_IMAGE = [".png", ".jpg", ".jpeg", ".webp"];
function detectFileType(filePath) {
    const ext = extname(filePath).toLowerCase();
    if (SUPPORTED_TEXT.includes(ext))
        return "text";
    if (SUPPORTED_IMAGE.includes(ext))
        return "image";
    return "unsupported";
}
// ============================================================================
// Content Hashing
// ============================================================================
async function hashFile(filePath) {
    const content = await readFile(filePath);
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
// ============================================================================
// Image Processing (placeholder for multimodal embedding)
// ============================================================================
async function processImage(filePath, embedder) {
    const base = basename(filePath);
    const fileHash = await hashFile(filePath);
    // For images, we embed the image path as a text identifier
    // The actual image embedding (pixels → vector) will be done by Qwen3-VL-8B
    // which accepts both text and image in its API
    const vector = (await embedder.embed(`[IMAGE:${filePath}]`))[0];
    const now = Date.now();
    return [
        {
            id: `${base}_${now}`,
            chunk_text: `[图片文件: ${base}]`,
            vector,
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
// Text Processing
// ============================================================================
async function processText(filePath, embedder) {
    const content = await readFile(filePath, "utf-8");
    const base = basename(filePath);
    const fileHash = await hashFile(filePath);
    const chunks = chunkText(content);
    const now = Date.now();
    const entries = [];
    for (let i = 0; i < chunks.length; i++) {
        const vector = (await embedder.embed(chunks[i]))[0];
        entries.push({
            id: `${base}_${i}_${now}`,
            chunk_text: chunks[i],
            vector,
            source_path: base,
            chunk_index: i,
            total_chunks: chunks.length,
            images: "[]",
            file_type: extname(filePath).slice(1),
            file_hash: fileHash,
            created_at: now,
            updated_at: now,
        });
    }
    return entries;
}
// ============================================================================
// Ingester
// ============================================================================
export class Ingester {
    store;
    embedder;
    constructor(store, embedder) {
        this.store = store;
        this.embedder = embedder;
    }
    async ingestFile(filePath) {
        const fileType = detectFileType(filePath);
        if (fileType === "unsupported") {
            console.log(`[Ark KB] 跳过不支持的文件: ${filePath}`);
            return { entries: 0, source: filePath };
        }
        // 先删除旧索引（如果已存在）
        const base = basename(filePath);
        await this.store.deleteBySource(base);
        // 嵌入新内容
        let entries;
        if (fileType === "image") {
            entries = await processImage(filePath, this.embedder);
        }
        else {
            entries = await processText(filePath, this.embedder);
        }
        if (entries.length === 0)
            return { entries: 0, source: base };
        await this.store.insert(entries);
        console.log(`[Ark KB] 已索引: ${base} (${entries.length} chunks)`);
        return { entries: entries.length, source: base };
    }
    async ingestDirectory(dirPath) {
        const files = await readdir(dirPath);
        let totalEntries = 0;
        let totalFiles = 0;
        for (const file of files) {
            const filePath = join(dirPath, file);
            try {
                const s = await stat(filePath);
                if (!s.isFile())
                    continue;
                const result = await this.ingestFile(filePath);
                totalEntries += result.entries;
                if (result.entries > 0)
                    totalFiles++;
            }
            catch (err) {
                console.error(`[Ark KB] 索引失败: ${filePath}`, err);
            }
        }
        return { total: totalEntries, files: totalFiles };
    }
}
//# sourceMappingURL=ingester.js.map