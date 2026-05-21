/**
 * Ark KB — Knowledge Store
 * LanceDB-backed vector store with in-memory fallback and BM25 inverted index.
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
export declare class BM25Index {
    private entries;
    private idf;
    private avgDocLen;
    private k1;
    private b;
    private tokenize;
    build(entries: KBEntry[]): void;
    search(queryText: string, k: number): Array<{
        entry: KBEntry;
        bm25Score: number;
    }>;
}
export declare class KnowledgeStore {
    private db;
    private table;
    private config;
    private inMemoryStore;
    private useInMemory;
    private bm25Index;
    constructor(config: StoreConfig);
    init(): Promise<void>;
    insert(entries: KBEntry[]): Promise<void>;
    private getAllEntries;
    vectorSearch(queryVector: number[], k: number): Promise<KBSearchResult[]>;
    private inMemoryVectorSearch;
    bm25Search(queryText: string, k: number): Promise<Array<{
        entry: KBEntry;
        bm25Score: number;
    }>>;
    /**
     * Fuse vector and BM25 results using weighted score fusion.
  /**
     * Fuse vector and BM25 scores using the specified method.
     *
     * Methods:
     * - min_max: Normalize each list to [0,1] with min-max scaling, then weighted sum.
     * - z_score: Standardize each list (mean=0, stddev=1), then weighted sum.
     * - rrf: Reciprocal Rank Fusion — rank-based, ignoring score magnitudes.
     * - raw: Weighted sum of raw scores (assumes scores are comparable).
     */
    fuseResults(vectorResults: KBSearchResult[], bm25Results: Array<{
        entry: KBEntry;
        bm25Score: number;
    }>, vectorWeight: number, method?: "min_max" | "z_score" | "rrf" | "raw"): KBSearchResult[];
    private fuseMinMax;
    private fuseZScore;
    private fuseRRF;
    private fuseRaw;
    deleteBySource(sourcePath: string): Promise<number>;
    listSources(): Promise<string[]>;
    count(): Promise<number>;
    close(): Promise<void>;
    private rowToEntry;
}
//# sourceMappingURL=store.d.ts.map