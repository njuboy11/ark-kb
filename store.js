/**
 * Ark KB — LanceDB Storage Layer
 * 负责向量索引的写入、搜索和管理
 *
 * ⚠️ 本文件为初始脚手架，实际实现将参考
 *    memory-lancedb-pro 插件中的 store.ts
 */
// ============================================================================
// LanceDB Store (Scaffold)
// ============================================================================
export class KnowledgeStore {
    db = null;
    table = null;
    config;
    inMemoryStore = new Map();
    useInMemory = true; // fallback until LanceDB API is finalized
    constructor(config) {
        this.config = config;
    }
    async init() {
        try {
            const lancedb = await import("@lancedb/lancedb");
            this.db = await lancedb.connect(this.config.dbPath);
            const tableNames = await this.db.tableNames();
            if (tableNames.includes("knowledge_base")) {
                this.table = await this.db.openTable("knowledge_base");
            }
            else {
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
                // 删除 dummy 记录
                await this.table.delete('id = "dummy_init"');
            }
            this.useInMemory = false;
            console.log(`[Ark KB] LanceDB 已连接: ${this.config.dbPath}`);
        }
        catch (err) {
            console.warn("[Ark KB] LanceDB 不可用，使用内存模式:", err);
            this.useInMemory = true;
        }
    }
    async insert(entries) {
        if (!this.useInMemory && this.table) {
            await this.table.add(entries);
        }
        else {
            // 内存模式
            for (const entry of entries) {
                const key = entry.source_path;
                const existing = this.inMemoryStore.get(key) || [];
                existing.push(entry);
                this.inMemoryStore.set(key, existing);
            }
        }
    }
    async search(queryVector, topK) {
        if (!this.useInMemory && this.table) {
            const lanceResults = await this.table.search(queryVector).limit(topK).execute();
            // Convert LanceDB result format to KBSearchResult[]
            // TODO: Handle exact result format based on LanceDB version
            if (Array.isArray(lanceResults)) {
                // Modern LanceDB returns arrays
                return lanceResults.map((r) => ({
                    entry: {
                        id: r.id || "",
                        chunk_text: r.chunk_text || "",
                        vector: r.vector || [],
                        source_path: r.source_path || "",
                        chunk_index: r.chunk_index || 0,
                        total_chunks: r.total_chunks || 1,
                        images: r.images || "[]",
                        file_type: r.file_type || "",
                        file_hash: r.file_hash || "",
                        created_at: r.created_at || 0,
                        updated_at: r.updated_at || 0,
                    },
                    score: r._distance ?? 0,
                }));
            }
            // Legacy format
            if (lanceResults && typeof lanceResults.toArray === "function") {
                const arr = await lanceResults.toArray();
                return arr.map((r) => ({
                    entry: r,
                    score: r._distance ?? 0,
                }));
            }
        }
        // 内存模式：暴力余弦相似度搜索
        return this.inMemorySearch(queryVector, topK);
    }
    inMemorySearch(queryVector, topK) {
        const results = [];
        for (const entries of this.inMemoryStore.values()) {
            for (const entry of entries) {
                const score = cosineSimilarity(queryVector, entry.vector);
                results.push({ entry, score });
            }
        }
        return results
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }
    async deleteBySource(sourcePath) {
        if (!this.useInMemory && this.table) {
            const before = await this.table.countRows();
            await this.table.delete(`source_path = '${escapeSqlLiteral(sourcePath)}'`);
            const after = await this.table.countRows();
            return before - after;
        }
        const entries = this.inMemoryStore.get(sourcePath);
        this.inMemoryStore.delete(sourcePath);
        return entries?.length || 0;
    }
    async listSources() {
        if (!this.useInMemory && this.table) {
            const results = (await this.table.query().select(["source_path"]).execute());
            if (Array.isArray(results)) {
                return [...new Set(results.map((r) => r.source_path))];
            }
            // Legacy iterable
            if (results && typeof results.toArray === "function") {
                const arr = await results.toArray();
                return [...new Set(arr.map((r) => r.source_path))];
            }
        }
        return [...this.inMemoryStore.keys()];
    }
    async count() {
        if (!this.useInMemory && this.table) {
            return await this.table.countRows();
        }
        let total = 0;
        for (const entries of this.inMemoryStore.values()) {
            total += entries.length;
        }
        return total;
    }
    async close() {
        if (this.db?.close) {
            this.db.close();
        }
        this.db = null;
        this.table = null;
    }
}
function escapeSqlLiteral(value) {
    return value.replace(/'/g, "''");
}
function cosineSimilarity(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
}
//# sourceMappingURL=store.js.map