/**
 * Ark KB — Ingester
 * File ingestion: detect type → hash → chunk → embed → upsert into store.
 * Handles text, images, and PDFs with configurable chunking.
 */
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
import { IngesterConfig } from "./index.js";
export type FileKind = "text" | "image" | "video" | "pdf" | "unsupported";
export declare function detectFileKind(filePath: string): FileKind;
export declare function hashFile(filePath: string): Promise<string>;
/**
 * Split text into chunks using the configured strategy.
 * Tokens are approximated as chars for CJK text.
 */
export declare function chunkText(text: string, config: {
    maxTokens: number;
    overlapTokens: number;
    strategy: string;
}): string[];
/**
 * Extract text from PDF using MinerU API or built-in pdf-parse.
 */
export declare function extractPdfText(filePath: string, pdfConfig: NonNullable<IngesterConfig["pdfParser"]>): Promise<string>;
export declare class Ingester {
    private store;
    private embedder;
    private config;
    private videoConfig;
    private imageConfig;
    private imageMethod;
    private videoMethod;
    private knowledgePath;
    constructor(store: KnowledgeStore, embedder: Embedder, config: IngesterConfig, knowledgePath?: string, videoConfig?: {
        endpoint: string;
        apiKey: string;
        maxFrames: number;
        timeoutMs?: number;
    }, imageConfig?: {
        endpoint: string;
        apiKey: string;
        timeoutMs: number;
    }, modes?: {
        imageMethod?: "text" | "multimodal";
        videoMethod?: "text" | "multimodal";
    });
    /**
     * Ingest a single file: detect type → hash → chunk → embed → upsert.
     * Skips files with no changes (hash comparison).
     * Returns the number of entries inserted.
     */
    ingestFile(filePath: string): Promise<{
        entries: number;
        source: string;
        skipped: boolean;
    }>;
    /**
     * Recursively ingest all supported files in a directory.
     */
    /** Scan knowledge dir and re-ingest only files missing from LanceDB or with changed hash */
    heal(dirPath: string): Promise<{
        healed: number;
        skipped: number;
    }>;
    /** Scan and ingest all files in a directory (unconditional). */
    ingestDirectory(dirPath: string): Promise<{
        total: number;
        files: number;
        errors: number;
    }>;
}
//# sourceMappingURL=ingester.d.ts.map