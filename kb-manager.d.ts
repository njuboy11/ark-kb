/**
 * Ark KB — KBManager
 * Manages multiple knowledge bases as subfolders of knowledgePath.
 * Each KB = one LanceDB table (tableName = folder name).
 */
import { KnowledgeStore } from "./store.js";
import { Ingester } from "./ingester.js";
export type { KBEntry, KBSearchResult, StoreOptions } from "./store.js";
export interface KBInfo {
    name: string;
    path: string;
    fileCount: number;
    chunkCount: number;
}
export interface SearchResult {
    entry: any;
    score: number;
    kbName: string;
}
export interface IngestResult {
    entries: number;
    source: string;
    skipped: boolean;
    kbName: string;
}
export interface DeleteKBResult {
    message?: string;
    requiresConfirm?: boolean;
    deleted?: boolean;
    kbName?: string;
}
export interface RemoveResult {
    kbName: string;
    deleted: number;
}
/** Options for MultiKBManager */
export interface MultiKBOptions {
    knowledgePath: string;
    dbPath: string;
    vectorDim: number;
    /** Optional embedder config for ingestion (ingestByPath won't work without this) */
    embedderConfig?: {
        api?: string;
        endpoint?: string;
        apiKey?: string;
        model?: string;
        chunking?: {
            maxTokens: number;
            overlapTokens: number;
            strategy: "paragraph" | "fixed" | "sentence";
        };
    };
    /** Video summarizer config (needed for video text mode) */
    videoConfig?: {
        endpoint: string;
        apiKey: string;
        maxFrames: number;
        timeoutMs?: number;
    };
    /** Image summarizer config (needed for image text mode) */
    imageConfig?: {
        endpoint: string;
        apiKey: string;
        timeoutMs: number;
    };
    /** Embedding/Reranker mode settings */
    modes?: {
        embeddingMode?: "text" | "multimodal";
        imageRerankerMode?: "text" | "multimodal";
        videoRerankerMode?: "text" | "multimodal";
    };
}
/**
 * MultiKBManager — manages multiple LanceDB-backed knowledge bases.
 *
 * Directory structure:
 *   knowledgePath/
 *     default/         ← default KB (tableName = "default")
 *       file1.md
 *       file2.pdf
 *     project-a/      ← KB named "project-a"
 *       readme.md
 *     project-b/
 *       ...
 */
export declare class KBManager {
    private knowledgePath;
    private dbPath;
    private vectorDim;
    private embedderConfig;
    private kbs;
    private ingesters;
    private _videoConfig;
    private _imageConfig;
    private _modes;
    constructor(opts: MultiKBOptions);
    /**
     * Initialize: scan subfolders, auto-migrate root-level files to `default`,
     * then init() all KnowledgeStore instances.
     */
    init(): Promise<void>;
    /** Auto-migrate root-level files to a `default` KB. */
    private _autoMigrate;
    /** Init a single KB store (creates folder if missing + inits KnowledgeStore). */
    private _initKB;
    /** Build a minimal Ingester for the given store (PDF parsing disabled, no media summarizers). */
    private _makeIngester;
    /**
     * Create a new knowledge base (subfolder + LanceDB table).
     */
    createKB(name: string): Promise<void>;
    /**
     * Delete a knowledge base.
     * @param name KB name
     * @param confirm Must be true to execute deletion
     * @returns confirmation prompt if confirm=false, otherwise deletes and returns result
     */
    deleteKB(name: string, confirm: boolean): Promise<DeleteKBResult>;
    /**
     * List all knowledge bases with file count and chunk count.
     */
    listKBs(): Promise<KBInfo[]>;
    /**
     * Get a KnowledgeStore instance by KB name.
     */
    getKB(name: string): KnowledgeStore | undefined;
    /**
     * Get the name of the default KB ("default" if it exists, otherwise first KB).
     */
    getDefaultKBName(): string;
    /**
     * Get all KB names.
     */
    getAllKBNames(): string[];
    /**
     * Get an Ingester instance by KB name.
     */
    getIngester(name: string): Ingester | undefined;
    /**
     * Re-ingest all files in a directory (heal/re-index).
     * Returns aggregate healed + skipped counts across all KBs.
     */
    heal(knowledgePath: string): Promise<{
        healed: number;
        skipped: number;
    }>;
    /**
     * Search all knowledge bases and merge/rank results.
     * @param query Query string
     * @param searchFn Function that takes (KnowledgeStore, query, topK) and returns search results
     * @param topK Top results per KB (default 5)
     */
    searchAll(query: string, searchFn: (store: KnowledgeStore, query: string, topK: number) => Promise<{
        entry: any;
        score: number;
    }[]>, topK?: number): Promise<SearchResult[]>;
    /**
     * Ingest a file into the appropriate KB based on its path.
     * Determines KB by the folder the file is in.
     */
    ingestByPath(filePath: string): Promise<IngestResult>;
    /**
     * Determine which KB a file belongs to based on its path.
     * Falls back to "default" if the immediate parent folder is not a known KB.
     */
    private _resolveKBForPath;
    /**
     * Remove a file (by source path) from all knowledge bases.
     */
    removeFromAll(sourcePath: string): Promise<RemoveResult[]>;
    close(): Promise<void>;
}
//# sourceMappingURL=kb-manager.d.ts.map