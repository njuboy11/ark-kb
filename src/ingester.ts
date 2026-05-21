/**
 * Ark KB — Ingester
 * File reading, chunking, embedding, and indexing.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { extname, basename, join } from "node:path";
import { createHash } from "node:crypto";
import { KnowledgeStore, KBEntry } from "./store.js";
import { Embedder } from "./embedder.js";
import type { ResolvedConfig } from "./config.js";

// ============================================================================
// Supported file types
// ============================================================================

const TEXT_EXTS = new Set([".md", ".txt", ".csv", ".html", ".json"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const PDF_EXT = ".pdf";

const SUPPORTED_EXTS = new Set([...TEXT_EXTS, ...IMAGE_EXTS, PDF_EXT]);

// ============================================================================
// Ingester
// ============================================================================

export class Ingester {
  private store: KnowledgeStore;
  private embedder: Embedder;
  private config: ResolvedConfig;

  constructor(store: KnowledgeStore, embedder: Embedder, config: ResolvedConfig) {
    this.store = store;
    this.embedder = embedder;
    this.config = config;
  }

  /**
   * Ingest a single file. Detects type, chunks, dedupes by hash, embeds, and indexes.
   */
  async ingestFile(filePath: string): Promise<{ entries: number; source: string }> {
    const ext = extname(filePath).toLowerCase();

    if (!SUPPORTED_EXTS.has(ext)) {
      console.log(`[Ark KB] Skipping unsupported file type: ${filePath}`);
      return { entries: 0, source: basename(filePath) };
    }

    // Check for PDF
    if (ext === PDF_EXT) {
      return await this.ingestPdf(filePath);
    }

    // Check for image
    if (IMAGE_EXTS.has(ext)) {
      return await this.ingestImage(filePath);
    }

    // Text-based file
    return await this.ingestText(filePath);
  }

  /**
   * Recursively ingest all supported files under dirPath.
   */
  async ingestDirectory(dirPath: string): Promise<{ total: number; files: number }> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    let totalEntries = 0;
    let totalFiles = 0;

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        const sub = await this.ingestDirectory(fullPath);
        totalEntries += sub.total;
        totalFiles += sub.files;
      } else if (entry.isFile()) {
        try {
          const result = await this.ingestFile(fullPath);
          totalEntries += result.entries;
          if (result.entries > 0) totalFiles++;
        } catch (err) {
          console.error(`[Ark KB] Failed to ingest: ${fullPath}`, err);
        }
      }
    }

    return { total: totalEntries, files: totalFiles };
  }

  // ========================================================================
  // Text ingestion
  // ========================================================================

  private async ingestText(filePath: string): Promise<{ entries: number; source: string }> {
    const base = basename(filePath);

    // Read content
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (err) {
      console.error(`[Ark KB] Failed to read text file: ${filePath}`, err);
      return { entries: 0, source: base };
    }

    // Hash for dedup
    const fileHash = await sha256(await readFile(filePath));

    // Remove existing chunks for this source (dedup / update)
    await this.store.deleteBySource(base);

    // Chunk text
    const chunks = this.chunkText(content, this.config.chunking.strategy);

    if (chunks.length === 0) {
      return { entries: 0, source: base };
    }

    const now = Date.now();

    // Batch embed all chunks
    const vectors = await this.embedder.embed(chunks);

    // Build entries
    const entries: KBEntry[] = chunks.map((text, i) => ({
      id: `${base}_${i}_${now}`,
      chunk_text: text,
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

    await this.store.insert(entries);
    console.log(`[Ark KB] Indexed: ${base} (${entries.length} chunks)`);

    return { entries: entries.length, source: base };
  }

  // ========================================================================
  // Image ingestion
  // ========================================================================

  private async ingestImage(filePath: string): Promise<{ entries: number; source: string }> {
    const base = basename(filePath);
    const fileHash = await sha256(await readFile(filePath));

    await this.store.deleteBySource(base);

    const now = Date.now();
    const ext = extname(filePath).toLowerCase();

    // For now, embed a text description of the image metadata.
    // In the future, pixel-level embedding can be added here.
    const desc = `[Image file: ${base}]`;
    const [vector] = await this.embedder.embed(desc);

    const entry: KBEntry = {
      id: `${base}_${now}`,
      chunk_text: desc,
      vector,
      source_path: base,
      chunk_index: 0,
      total_chunks: 1,
      images: JSON.stringify([base]),
      file_type: ext.slice(1),
      file_hash: fileHash,
      created_at: now,
      updated_at: now,
    };

    await this.store.insert([entry]);
    console.log(`[Ark KB] Indexed image: ${base}`);

    return { entries: 1, source: base };
  }

  // ========================================================================
  // PDF ingestion
  // ========================================================================

  private async ingestPdf(filePath: string): Promise<{ entries: number; source: string }> {
    const base = basename(filePath);
    const pdfApi = this.config.pdfParser.api;

    if (pdfApi === "none") {
      console.log(`[Ark KB] Skipping PDF (no parser configured): ${filePath}`);
      return { entries: 0, source: base };
    }

    if (pdfApi === "mineru") {
      return await this.ingestPdfMinERU(filePath);
    }

    if (pdfApi === "builtin") {
      console.warn(`[Ark KB] Builtin PDF parsing is limited; recommend configuring MinerU for better results: ${filePath}`);
      // Fall through: just treat as binary and skip for now
      return { entries: 0, source: base };
    }

    return { entries: 0, source: base };
  }

  private async ingestPdfMinERU(filePath: string): Promise<{ entries: number; source: string }> {
    const base = basename(filePath);
    const endpoint = this.config.pdfParser.endpoint;
    const apiKey = this.config.pdfParser.apiKey;
    const model = this.config.pdfParser.model;

    if (!endpoint) {
      console.error("[Ark KB] MinerU endpoint not configured");
      return { entries: 0, source: base };
    }

    try {
      const fileBuffer = await readFile(filePath);
      const base64Content = fileBuffer.toString("base64");

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          file: { content: base64Content, name: basename(filePath) },
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`MinerU API error (${response.status}): ${err}`);
      }

      const data = await response.json() as any;
      // Expected: data.content or data.text — array of page texts
      const pages: string[] = data.content ?? data.text ?? [];
      const fileHash = await sha256(await readFile(filePath));

      await this.store.deleteBySource(base);

      const allChunks: string[] = [];
      for (const pageText of pages) {
        const pageChunks = this.chunkText(pageText, this.config.chunking.strategy);
        allChunks.push(...pageChunks);
      }

      if (allChunks.length === 0) {
        return { entries: 0, source: base };
      }

      const now = Date.now();
      const vectors = await this.embedder.embed(allChunks);

      const entries: KBEntry[] = allChunks.map((text, i) => ({
        id: `${base}_${i}_${now}`,
        chunk_text: text,
        vector: vectors[i],
        source_path: base,
        chunk_index: i,
        total_chunks: allChunks.length,
        images: "[]",
        file_type: "pdf",
        file_hash: fileHash,
        created_at: now,
        updated_at: now,
      }));

      await this.store.insert(entries);
      console.log(`[Ark KB] Indexed PDF: ${base} (${entries.length} chunks from ${pages.length} pages)`);

      return { entries: entries.length, source: base };

    } catch (err) {
      console.error(`[Ark KB] MinerU PDF parsing failed for ${filePath}:`, err);
      return { entries: 0, source: base };
    }
  }

  // ========================================================================
  // Chunking strategies
  // ========================================================================

  private chunkText(text: string, strategy: "paragraph" | "fixed" | "sentence"): string[] {
    switch (strategy) {
      case "fixed":
        return this.chunkFixed(text);
      case "sentence":
        return this.chunkSentence(text);
      case "paragraph":
      default:
        return this.chunkParagraph(text);
    }
  }

  /**
   * Paragraph strategy: split by blank lines, merge chunks to maxTokens.
   */
  private chunkParagraph(text: string): string[] {
    const paragraphs = text.split(/\n\n+/).filter((s) => s.trim().length > 0);
    const chunks: string[] = [];
    let current = "";
    const maxChars = this.config.chunking.maxTokens * 4; // rough chars≈tokens for CJK
    const overlapChars = this.config.chunking.overlapTokens * 4;

    for (const para of paragraphs) {
      if (current.length + para.length > maxChars && current.length > 0) {
        chunks.push(current.trim());
        // Overlap: keep last overlapChars as prefix
        current = current.slice(-overlapChars) + "\n\n" + para;
      } else {
        current += (current ? "\n\n" : "") + para;
      }
    }

    if (current.trim()) {
      chunks.push(current.trim());
    }

    return chunks;
  }

  /**
   * Fixed-size strategy: slice text into chunks of exactly maxTokens chars.
   */
  private chunkFixed(text: string): string[] {
    const maxChars = this.config.chunking.maxTokens * 4;
    const overlapChars = this.config.chunking.overlapTokens * 4;
    const chunks: string[] = [];
    let pos = 0;

    while (pos < text.length) {
      const chunk = text.slice(pos, pos + maxChars);
      if (chunk.trim()) {
        chunks.push(chunk.trim());
      }
      pos += maxChars - overlapChars;
      if (pos <= 0) break; // safety guard
    }

    return chunks;
  }

  /**
   * Sentence strategy: split by sentence-ending punctuation, merge to maxTokens.
   */
  private chunkSentence(text: string): string[] {
    // Split by . ! ? followed by space or newline
    const sentenceRegex = /[^.!?]*[.!?]+(?:\s+|\n+|$)|[^.!?]+$/g;
    const sentences = text.match(sentenceRegex)?.filter((s) => s.trim().length > 0) ?? [];
    const chunks: string[] = [];
    let current = "";
    const maxChars = this.config.chunking.maxTokens * 4;
    const overlapChars = this.config.chunking.overlapTokens * 4;

    for (const sentence of sentences) {
      if (current.length + sentence.length > maxChars && current.length > 0) {
        chunks.push(current.trim());
        current = current.slice(-overlapChars) + sentence;
      } else {
        current += (current ? " " : "") + sentence;
      }
    }

    if (current.trim()) {
      chunks.push(current.trim());
    }

    return chunks;
  }
}

// ============================================================================
// Helpers
// ============================================================================

async function sha256(buffer: Buffer): Promise<string> {
  return createHash("sha256").update(buffer).digest("hex");
}
