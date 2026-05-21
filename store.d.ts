/**
 * Ark KB — LanceDB Storage Layer
 * 负责向量索引的写入、搜索和管理
 *
 * ⚠️ 本文件为初始脚手架，实际实现将参考
 *    memory-lancedb-pro 插件中的 store.ts
 */
export interface KBEntry {
    id: string;
    chunk_text: string;
    vector: number[];
    source_path: string;
    chunk_index: number;
    total_chunks: number;
    images: string;
    file_type: string;
    file_hash: string;
    created_at: number;
    updated_at: number;
}
export interface KBSearchResult {
    entry: KBEntry;
    score: number;
}
export interface StoreConfig {
    dbPath: string;
    vectorDim: number;
}
export declare class KnowledgeStore {
    private db;
    private table;
    private config;
    private inMemoryStore;
    private useInMemory;
    constructor(config: StoreConfig);
    init(): Promise<void>;
    insert(entries: KBEntry[]): Promise<void>;
    search(queryVector: number[], topK: number): Promise<KBSearchResult[]>;
    private inMemorySearch;
    deleteBySource(sourcePath: string): Promise<number>;
    listSources(): Promise<string[]>;
    count(): Promise<number>;
    close(): Promise<void>;
}
//# sourceMappingURL=store.d.ts.map