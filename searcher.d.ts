/**
 * Ark KB — Searcher
 * Hybrid BM25 + vector search with optional reranking.
 */
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
import type { ResolvedConfig } from "./config.js";
export interface SearchOptions {
    query: string;
    topK?: number;
    resultCount?: number;
    vectorWeight?: number;
    bm25Enabled?: boolean;
    rerankerEnabled?: boolean;
    rerankerMinScore?: number;
}
export interface SearchResult {
    score: number;
    chunk_text: string;
    source_path: string;
    chunk_index: number;
    total_chunks: number;
    images: string[];
    file_type: string;
}
export interface SourceContent {
    source_path: string;
    full_text: string;
}
export declare class Searcher {
    private store;
    private embedder;
    private config;
    constructor(store: KnowledgeStore, embedder: Embedder, config: ResolvedConfig);
    search(options: SearchOptions): Promise<SearchResult[]>;
    /**
     * Read the full content of a source file.
     */
    getSource(sourcePath: string): Promise<SourceContent | null>;
    private applyReranker;
}
//# sourceMappingURL=searcher.d.ts.map