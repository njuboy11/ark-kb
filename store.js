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
    tableName;
    constructor(config) {
        this.config = config;
        this.tableName = config.tableName ?? "default";
    }
    /**
     * List all table names in a LanceDB database.
     */
    static async listTables(opts) {
        const lancedb = await import("@lancedb/lancedb");
        const dbDir = opts.dbPath.startsWith("~")
            ? path.join(process.env.HOME || "/root", opts.dbPath.slice(1))
            : opts.dbPath;
        const db = await lancedb.connect(dbDir);
        try {
            return await db.tableNames();
        }
        finally {
            if (db?.close)
                db.close();
        }
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
        if (tableNames.includes(this.tableName)) {
            this.table = await this.db.openTable(this.tableName);
        }
        else {
            // Create table with a dummy row then delete it
            this.table = await this.db.createTable(this.tableName, [
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
                console.log(`[Ark KB] BM25 FTS index created on table "${this.tableName}"`);
            }
        }
        catch (err) {
            console.warn("[Ark KB] Failed to create FTS index:", err.message);
        }
        console.log(`[Ark KB] LanceDB connected: ${dbDir} [table="${this.tableName}"]`);
    }
    /**
     * Drop (delete) the current table from the database.
     */
    async drop() {
        if (!this.db) {
            throw new Error("[Ark KB] Store not initialized — call init() first");
        }
        await this.db.dropTable(this.tableName);
        this.table = null;
        console.log(`[Ark KB] Table "${this.tableName}" dropped`);
    }
    /**
     * Return information about the current table.
     */
    async tableInfo() {
        if (!this.table) {
            throw new Error("[Ark KB] Store not initialized — call init() first");
        }
        const chunks = await this.table.countRows();
        const results = await this.table.query().select(["source_path"]).execute();
        const rows = await collectRows(results);
        const files = rows
            .map((r) => r.source_path)
            .filter((s) => typeof s === "string" && s.length > 0);
        return { chunks, files: [...new Set(files)] };
    }
    /**
     * Insert KBEntry array in a single batch.
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
     * Vector ANN search.
     * Returns results sorted by distance score.
     */
    async search(queryVector, topK, fileType) {
        if (!this.table) {
            throw new Error("[Ark KB] Store not initialized — call init() first");
        }
        let query = this.table
            .search(queryVector, { columns: ["vector"] })
            .limit(topK * 3); // over-fetch for hybrid merge;
        if (fileType) {
            query = query.filter(`file_type = '${fileType}'`);
        }
        const allResults = await query.execute();
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
     * Check if a file_hash exists in any source (third-layer deduplication).
     * Returns true if the hash is found in any entry, false otherwise.
     */
    async hasFileHash(hash) {
        if (!this.table) {
            throw new Error("[Ark KB] Store not initialized — call init() first");
        }
        const results = await this.table.query()
            .filter(`file_hash = '${hash}'`)
            .limit(1)
            .execute();
        const rows = await collectRows(results);
        return rows.length > 0;
    }
    /**
     * Compact this KB: merge fragments + prune old versions.
     * Returns statistics about what was cleaned up.
     */
    async compact(options) {
        const cleanupMs = Date.now() - options.cleanupDays * 86_400_000;
        const cleanupOlderThan = new Date(cleanupMs);
        const startFragments = await this._countFragments();
        const startTime = Date.now();
        // Dry-run: return estimated stats without actually optimizing
        if (options.dryRun) {
            return {
                kbName: this.tableName,
                durationMs: Date.now() - startTime,
                compaction: (options.op === "all" || options.op === "compact")
                    ? { fragmentsBefore: startFragments, fragmentsAfter: startFragments, fragmentsRemoved: 0, bytesFreed: 0 }
                    : undefined,
                prune: (options.op === "all" || options.op === "prune")
                    ? { oldVersionsRemoved: 0, bytesRemoved: 0 }
                    : undefined,
                index: (options.op === "all" || options.op === "index")
                    ? { fragmentsRemapped: 0 }
                    : undefined,
            };
        }
        // Build optimize options based on op
        const compactOpts = {};
        if (options.op === "all" || options.op === "compact") {
            compactOpts.compact = {}; // triggers fragment compaction
        }
        if (options.op === "all" || options.op === "prune") {
            compactOpts.prune = {
                olderThan: cleanupOlderThan,
                deleteUnverified: options.aggressive,
            };
        }
        if (options.op === "all" || options.op === "index") {
            compactOpts.index = {}; // triggers vector index remapping
        }
        const result = await this.table.optimize(compactOpts);
        const endFragments = await this._countFragments();
        return {
            kbName: this.tableName,
            durationMs: Date.now() - startTime,
            compaction: result.compaction
                ? {
                    fragmentsBefore: startFragments,
                    fragmentsAfter: endFragments,
                    fragmentsRemoved: result.compaction.fragmentsRemoved ?? 0,
                    bytesFreed: 0, // LanceDB doesn't expose per-file sizes
                }
                : undefined,
            prune: result.prune
                ? {
                    oldVersionsRemoved: result.prune.oldVersionsRemoved ?? 0,
                    bytesRemoved: result.prune.bytesRemoved ?? 0,
                }
                : undefined,
            index: result.index
                ? { fragmentsRemapped: result.index.fragmentsRemapped ?? 0 }
                : undefined,
        };
    }
    async _countFragments() {
        try {
            const arrow = await this.table.query().select(["vector"]).toArrow();
            // LanceDB doesn't expose fragment count directly in JS SDK,
            // so we estimate from the data directory
            const dataDir = path.join(this.config.dbPath, `${this.tableName}.lance`, "data");
            if (fs.existsSync(dataDir)) {
                return fs.readdirSync(dataDir).filter(f => f.endsWith(".lance")).length;
            }
            return 0;
        }
        catch {
            return 0;
        }
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