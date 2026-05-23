/**
 * Ark KB — KnowledgeStore
 * LanceDB-backed vector store with FTS (BM25) support.
 * NO in-memory fallback — LanceDB failure throws.
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
export interface StoreOptions {
    dbPath: string;
    vectorDim: number;
    tableName?: string;
}
export declare class KnowledgeStore {
    private db;
    private table;
    private config;
    private tableName;
    constructor(config: StoreOptions);
    /**
     * List all table names in a LanceDB database.
     */
    static listTables(opts: {
        dbPath: string;
    }): Promise<string[]>;
    init(): Promise<void>;
    /**
     * Drop (delete) the current table from the database.
     */
    drop(): Promise<void>;
    /**
     * Return information about the current table.
     */
    tableInfo(): Promise<{
        chunks: number;
        files: string[];
    }>;
    /**
     * Insert KBEntry array in a single batch.
     */
    insert(entries: KBEntry[]): Promise<void>;
    /**
     * Vector ANN search.
     * Returns results sorted by distance score.
     */
    search(queryVector: number[], topK: number): Promise<KBSearchResult[]>;
    /**
     * BM25-style full-text search using LanceDB FTS.
     * Falls back to vector-only search if FTS is not available.
     */
    searchBM25(query: string, topK: number): Promise<KBSearchResult[]>;
    /**
     * Delete all entries belonging to a source path.
     * Returns the number of deleted entries.
     */
    deleteBySource(sourcePath: string): Promise<number>;
    /**
     * List all unique source paths in the store.
     */
    listSources(): Promise<string[]>;
    /**
     * Total number of chunk entries.
     */
    count(): Promise<number>;
    /**
     * Check if a file_hash exists in any source (third-layer deduplication).
     * Returns true if the hash is found in any entry, false otherwise.
     */
    hasFileHash(hash: string): Promise<boolean>;
    /**
     * Close the database connection.
     */
    close(): Promise<void>;
}
//# sourceMappingURL=store.d.ts.map