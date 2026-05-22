/**
 * Ark KB — Searcher
 * Hybrid BM25 + vector search with weighted fusion and optional reranking.
 */
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
import { SearcherConfig } from "./index.js";
export interface SearchOptions {
    query: string;
    topK?: number;
    rerankerEnabled?: boolean;
    rerankerMinScore?: number;
    resultCount?: number;
}
export interface SearchResult {
    score: number;
    chunk_text: string;
    source_path: string;
    chunk_index: number;
    total_chunks: number;
    images: string[];
    file_type: string;
    relevance_score?: number;
}
export interface SourceContent {
    source_path: string;
    full_text: string;
}
export declare class Searcher {
    private store;
    private embedder;
    private knowledgePath;
    private config;
    constructor(store: KnowledgeStore, embedder: Embedder, knowledgePath: string, config: SearcherConfig);
    /**
     * Perform hybrid search: vector ANN + BM25, weighted fusion, optional rerank.
     */
    search(options: SearchOptions): Promise<SearchResult[]>;
    /**
     * Read the full source file from the knowledge path.
     */
    getSource(sourcePath: string): Promise<SourceContent | null>;
    /**
     * Apply reranker API for precision re-ranking.
     */
    private applyReranker;
    /** Call a single reranker API and return scored results. Falls back to input on error. */
    private callReranker;
    private detectRerankerApi;
}
//# sourceMappingURL=searcher.d.ts.map