/**
 * Ark KB — Main Entry
 * Initializes and wires together Store, Embedder, Ingester, Searcher, and Watcher.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
import { Ingester } from "./ingester.js";
import { Searcher } from "./searcher.js";
import { FileWatcher } from "./watcher.js";
import { resolveConfig } from "./config.js";
import { registerKBTools } from "./tools.js";
// ============================================================================
// ArkKB
// ============================================================================
export class ArkKB {
    store;
    embedder;
    ingester;
    searcher;
    watcher;
    config;
    initialized = false;
    constructor(config) {
        this.config = resolveConfig(config);
        // Expand ~ in paths
        const dbPath = expandPath(this.config.storage.dbPath);
        const knowledgePath = this.config.knowledgePath;
        // Ensure directories exist
        if (knowledgePath && !existsSync(knowledgePath)) {
            mkdirSync(knowledgePath, { recursive: true });
        }
        if (!existsSync(dbPath)) {
            mkdirSync(dbPath, { recursive: true });
        }
        // Wire up components
        this.store = new KnowledgeStore({
            dbPath,
            vectorDim: this.config.embedding.dimensions,
        });
        this.embedder = new Embedder({
            api: this.config.embedding.api,
            endpoint: this.config.embedding.endpoint,
            apiKey: this.config.embedding.apiKey,
            model: this.config.embedding.model,
            dimensions: this.config.embedding.dimensions,
            batchSize: this.config.embedding.batchSize,
        });
        this.ingester = new Ingester(this.store, this.embedder, this.config);
        this.searcher = new Searcher(this.store, this.embedder, this.config);
        this.watcher = new FileWatcher();
    }
    async init() {
        if (this.initialized)
            return;
        // 1. Initialize LanceDB
        console.log("[Ark KB] Initializing LanceDB...");
        await this.store.init();
        // 2. Ingest knowledge directory
        if (this.config.knowledgePath) {
            console.log("[Ark KB] Ingesting knowledge directory...");
            const { total, files } = await this.ingester.ingestDirectory(this.config.knowledgePath);
            console.log(`[Ark KB] Indexed ${files} files, ${total} chunks total`);
            // 3. Start file watcher
            if (this.config.watcher.enabled) {
                this.watcher.start(this.config.knowledgePath, async (event, filePath) => {
                    if (event === "add" || event === "change") {
                        await this.ingester.ingestFile(filePath);
                    }
                    else if (event === "unlink") {
                        const base = filePath.split("/").pop() ?? filePath;
                        const deleted = await this.store.deleteBySource(base);
                        console.log(`[Ark KB] Removed: ${base} (${deleted} chunks)`);
                    }
                }, this.config.watcher.debounceMs, this.config.watcher.ignorePatterns);
                console.log(`[Ark KB] File watcher active: ${this.config.knowledgePath}`);
            }
        }
        else {
            console.log("[Ark KB] No knowledgePath configured; skipping auto-ingest and watcher.");
        }
        this.initialized = true;
        console.log("[Ark KB] Ready.");
    }
    // ========================================================================
    // Public API
    // ========================================================================
    async search(query, options) {
        return await this.searcher.search({
            query,
            topK: options?.topK ?? this.config.search.topK,
            resultCount: options?.resultCount ?? this.config.search.resultCount,
            vectorWeight: options?.vectorWeight ?? this.config.search.vectorWeight,
            bm25Enabled: options?.bm25Enabled ?? this.config.search.bm25Enabled,
            rerankerEnabled: options?.rerankerEnabled ?? (this.config.reranker.api !== "none"),
            rerankerMinScore: options?.rerankerMinScore ?? this.config.reranker.minScore,
        });
    }
    async ingestFile(filePath) {
        return await this.ingester.ingestFile(filePath);
    }
    async ingestDirectory() {
        if (!this.config.knowledgePath) {
            return { total: 0, files: 0 };
        }
        return await this.ingester.ingestDirectory(this.config.knowledgePath);
    }
    async removeSource(sourcePath) {
        return await this.store.deleteBySource(sourcePath);
    }
    async status() {
        const [chunkCount, sources] = await Promise.all([
            this.store.count(),
            this.store.listSources(),
        ]);
        return { chunkCount, sources };
    }
    async shutdown() {
        this.watcher.stop();
        await this.store.close();
        console.log("[Ark KB] Shutdown complete.");
    }
    /**
     * Returns the tool registration array for OpenClaw.
     */
    getTools() {
        return registerKBTools(this);
    }
}
// ============================================================================
// Helpers
// ============================================================================
function expandPath(p) {
    if (p.startsWith("~/")) {
        return join(homedir(), p.slice(2));
    }
    return p;
}
//# sourceMappingURL=index.js.map