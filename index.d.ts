/**
 * Ark KB — Main Entry
 * 🏛️ Ark Knowledge Base — 基于 LanceDB + 多模态 Embedding 的个人知识库
 */
import { registerKBTools } from "./tools.js";
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
import { Ingester } from "./ingester.js";
import { Searcher, SearchOptions } from "./searcher.js";
import { FileWatcher } from "./watcher.js";
export interface ArkKBConfig {
    knowledgePath: string;
    dbPath?: string;
    embeddingApiUrl?: string;
    embeddingApiKey?: string;
    embeddingModel?: string;
    vectorDim?: number;
    enableWatcher?: boolean;
    rerankerEnabled?: boolean;
    searchTopK?: number;
    rerankerMinScore?: number;
    resultCount?: number;
}
export declare const DEFAULTS: {
    dbPath: string;
    embeddingApiUrl: string;
    embeddingApiKey: string;
    embeddingModel: string;
    vectorDim: number;
    enableWatcher: boolean;
    rerankerEnabled: boolean;
    searchTopK: number;
    rerankerMinScore: number;
    resultCount: number;
};
export declare class ArkKB {
    store: KnowledgeStore;
    embedder: Embedder;
    ingester: Ingester;
    searcher: Searcher;
    watcher: FileWatcher;
    config: Required<ArkKBConfig>;
    private initialized;
    constructor(config: ArkKBConfig);
    init(): Promise<void>;
    search(query: string, options?: Partial<SearchOptions>): Promise<any>;
    ingestFile(filePath: string): Promise<any>;
    removeSource(sourcePath: string): Promise<number>;
    status(): Promise<{
        chunkCount: number;
        sources: string[];
    }>;
    shutdown(): Promise<void>;
    /**
     * 获取 OpenClaw 工具注册列表
     */
    getTools(): ReturnType<typeof registerKBTools>;
}
//# sourceMappingURL=index.d.ts.map