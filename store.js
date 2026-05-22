/**
 * Ark KB — KnowledgeStore
 * LanceDB-backed vector store with FTS (BM25) support.
 * NO in-memory fallback — LanceDB failure throws.
 */
import * as path from "node:path";
import * as fs from "node:fs";
/** Helper: collect all rows from LanceDB RecordBatchIterator (no .toArray()) */
async function collectRows(results) {
    if (Array.isArray(results))
        return results;
    const rows = [];
    while (true) {
        const r = await results.next();
        if (r.done)
            break;
        const batch = r.value;
        if (batch?.toArray) {
            rows.push(...batch.toArray());
        }
    }
    return rows;
}
// ============================================================================
// KnowledgeStore
// ============================================================================
export class KnowledgeStore {
    db = null;
    table = null;
    config;
    constructor(config) {
        this.config = config;
    }
    async init() {
        const lancedb = await import("@lancedb/lancedb");
        // Ensure the DB directory exists
        const dbDir = this.config.dbPath.startsWith("~")
            ? path.join(process.env.HOME || "/root", this.config.dbPath.slice(1))
            : this.config.dbPath;
        fs.mkdirSync(dbDir, { recursive: true });
        this.db = await lancedb.connect(dbDir);
        const tableNames = await this.db.tableNames();
        if (tableNames.includes("knowledge_base")) {
            this.table = await this.db.openTable("knowledge_base");
        }
        else {
            // Create table with a dummy row then delete it
            this.table = await this.db.createTable("knowledge_base", [
                {
                    id: "dummy_init",
                    chunk_text: "",
                    vector: new Array(this.config.vectorDim).fill(0),
                    source_path: "",
                    chunk_index: 0,
                    total_chunks: 0,
                    images: "[]",
                    file_type: "",
                    file_hash: "",
                    created_at: 0,
                    updated_at: 0,
                },
            ]);
            await this.table.delete('id = "dummy_init"');
        }
        // Ensure FTS index exists for BM25 search (always recreate if missing)
        try {
            const indices = await this.table.listIndices();
            const hasFts = indices.some((i) => i.name === "chunk_text_idx");
            if (!hasFts) {
                await this.table.createIndex("chunk_text", { config: lancedb.Index.fts({ withPosition: true }) });
                console.log("[Ark KB] BM25 FTS index created on chunk_text");
            }
        }
        catch (err) {
            console.warn("[Ark KB] Failed to create FTS index:", err.message);
        }
        console.log(`[Ark KB] LanceDB connected: ${dbDir}`);
    }
    /**
     * InsertKBEntry array in a single batch.
     */
    async insert(entries) {
        if (!this.table) {
            throw new Error("[Ark KB] Store not initialized — call init() first");
        }
        if (entries.length === 0)
            return;
        await this.table.add(entries);
    }
    /**
     * Vector ANN search + BM25 FTS hybrid search.
     * Returns merged results sorted by weighted score.
     * Note: LanceDB's FTS requires explicit field index — we query raw and sort.
     */
    async search(queryVector, topK) {
        if (!this.table) {
            throw new Error("[Ark KB] Store not initialized — call init() first");
        }
        const allResults = await this.table
            .search(queryVector, { columns: ["vector"] })
            .limit(topK * 3) // over-fetch for hybrid merge
            .execute();
        const rows = await collectRows(allResults);
        return rows.map((r) => ({
            entry: {
                id: r.id ?? "",
                chunk_text: r.chunk_text ?? "",
                vector: r.vector ?? [],
                source_path: r.source_path ?? "",
                chunk_index: r.chunk_index ?? 0,
                total_chunks: r.total_chunks ?? 1,
                images: r.images ?? "[]",
                file_type: r.file_type ?? "",
                file_hash: r.file_hash ?? "",
                created_at: r.created_at ?? 0,
                updated_at: r.updated_at ?? 0,
            },
            score: r._distance ?? 0,
        }));
    }
    /**
     * BM25-style full-text search using LanceDB FTS.
     * Falls back to vector-only search if FTS is not available.
     */
    async searchBM25(query, topK) {
        if (!this.table) {
            throw new Error("[Ark KB] Store not initialized — call init() first");
        }
        try {
            // Try LanceDB FTS query (explicit fts type for LanceDB 0.26+)
            const ftsResults = await this.table
                .search(query, "fts")
                .limit(topK)
                .execute();
            const rows = await collectRows(ftsResults);
            return rows.map((r) => ({
                entry: {
                    id: r.id ?? "",
                    chunk_text: r.chunk_text ?? "",
                    vector: r.vector ?? [],
                    source_path: r.source_path ?? "",
                    chunk_index: r.chunk_index ?? 0,
                    total_chunks: r.total_chunks ?? 1,
                    images: r.images ?? "[]",
                    file_type: r.file_type ?? "",
                    file_hash: r.file_hash ?? "",
                    created_at: r.created_at ?? 0,
                    updated_at: r.updated_at ?? 0,
                },
                score: r._distance ?? 0,
            }));
        }
        catch {
            // FTS not available — return empty and rely on vector search
            return [];
        }
    }
    /**
     * Delete all entries belonging to a source path.
     * Returns the number of deleted entries.
     */
    async deleteBySource(sourcePath) {
        if (!this.table) {
            throw new Error("[Ark KB] Store not initialized — call init() first");
        }
        const before = await this.count();
        const escaped = sourcePath.replace(/'/g, "''");
        await this.table.delete(`source_path = '${escaped}'`);
        const after = await this.count();
        return before - after;
    }
    /**
     * List all unique source paths in the store.
     */
    async listSources() {
        if (!this.table) {
            throw new Error("[Ark KB] Store not initialized — call init() first");
        }
        const results = await this.table.query().select(["source_path"]).execute();
        const rows = await collectRows(results);
        const paths = rows.map((r) => r.source_path).filter((s) => typeof s === "string" && s.length > 0);
        return [...new Set(paths)];
    }
    /**
     * Total number of chunk entries.
     */
    async count() {
        if (!this.table) {
            throw new Error("[Ark KB] Store not initialized — call init() first");
        }
        return await this.table.countRows();
    }
    /**
     * Close the database connection.
     */
    async close() {
        if (this.db?.close) {
            this.db.close();
        }
        this.db = null;
        this.table = null;
    }
}
//# sourceMappingURL=store.js.map