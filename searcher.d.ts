/**
 * Ark KB — Searcher
 * 语义搜索 + 可选的 Reranker 精排
 */
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
export interface SearchOptions {
    query: string;
    topK: number;
    rerankerEnabled: boolean;
    rerankerMinScore: number;
    resultCount: number;
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
    private knowledgePath;
    constructor(store: KnowledgeStore, embedder: Embedder, knowledgePath: string);
    search(options: SearchOptions): Promise<SearchResult[]>;
    /**
     * 获取搜索结果的完整原文
     */
    getSource(sourcePath: string): Promise<SourceContent | null>;
    /**
     * Reranker 精排（BGE-m3 或其他 cross-encoder）
     */
    private applyReranker;
}
//# sourceMappingURL=searcher.d.ts.map