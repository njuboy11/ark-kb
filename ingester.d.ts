/**
 * Ark KB — Ingester
 * File reading, chunking, embedding, and indexing.
 */
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
import type { ResolvedConfig } from "./config.js";
export declare class Ingester {
    private store;
    private embedder;
    private config;
    constructor(store: KnowledgeStore, embedder: Embedder, config: ResolvedConfig);
    /**
     * Ingest a single file. Detects type, chunks, dedupes by hash, embeds, and indexes.
     */
    ingestFile(filePath: string): Promise<{
        entries: number;
        source: string;
    }>;
    /**
     * Recursively ingest all supported files under dirPath.
     */
    ingestDirectory(dirPath: string): Promise<{
        total: number;
        files: number;
    }>;
    private ingestText;
    private ingestImage;
    private ingestPdf;
    private ingestPdfMinERU;
    private chunkText;
    /**
     * Paragraph strategy: split by blank lines, merge chunks to maxTokens.
     */
    private chunkParagraph;
    /**
     * Fixed-size strategy: slice text into chunks of exactly maxTokens chars.
     */
    private chunkFixed;
    /**
     * Sentence strategy: split by sentence-ending punctuation, merge to maxTokens.
     */
    private chunkSentence;
}
//# sourceMappingURL=ingester.d.ts.map