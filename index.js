/**
 * Ark KB — Main Entry
 * Wires together all components with nested config support.
 * Exports definePluginEntry-compatible register function for OpenClaw.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
import { Ingester } from "./ingester.js";
import { Searcher } from "./searcher.js";
import { FileWatcher } from "./watcher.js";
import { resolveConfig, } from "./config.js";
import { registerKBTools } from "./tools.js";
// ============================================================================
// ArkKB — Core class (used both by the plugin and for direct Node.js usage)
// ============================================================================
export class ArkKB {
    store;
    embedder;
    ingester;
    searcher;
    watcher;
    config;
    _initialized = false;
    constructor(rawConfig = {}) {
        this.config = resolveConfig(rawConfig);
        const dbPath = expandPath(this.config.storage.dbPath);
        if (!existsSync(dbPath)) {
            mkdirSync(dbPath, { recursive: true });
        }
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
        this.ingester = new Ingester(this.store, this.embedder, {
            chunking: this.config.chunking,
            pdfParser: this.config.pdfParser,
        });
        this.searcher = new Searcher(this.store, this.embedder, this.config.knowledgePath, {
            search: this.config.search,
            reranker: this.config.reranker,
        });
        this.watcher = new FileWatcher({
            enabled: this.config.watcher.enabled,
            paths: this.config.watcher.paths ?? [],
            debounceMs: this.config.watcher.debounceMs,
            ignorePatterns: this.config.watcher.ignorePatterns,
        });
    }
    async init() {
        if (this._initialized)
            return;
        await this.store.init();
        const kp = this.config.knowledgePath;
        let total = 0;
        let files = 0;
        if (kp) {
            const result = await this.ingester.ingestDirectory(kp);
            total = result.total;
            files = result.files;
        }
        if (this.config.watcher.enabled && kp) {
            this.watcher.start(kp, async (event, filePath) => {
                const base = filePath.split("/").pop() || filePath;
                if (event === "add" || event === "change") {
                    try {
                        await this.ingester.ingestFile(filePath);
                    }
                    catch (err) {
                        console.error(`[Ark KB] Watcher ingest error (${filePath}): ${err.message}`);
                    }
                }
                else if (event === "unlink") {
                    try {
                        await this.store.deleteBySource(base);
                    }
                    catch (err) {
                        console.error(`[Ark KB] Watcher delete error (${base}): ${err.message}`);
                    }
                }
            });
        }
        this._initialized = true;
        console.log(`[Ark KB] Ready — ${total} chunks, ${files} files`);
    }
    async search(query, options) {
        return await this.searcher.search({
            query,
            topK: options?.topK,
            rerankerEnabled: options?.rerankerEnabled,
            rerankerMinScore: options?.rerankerMinScore,
            resultCount: options?.resultCount,
        });
    }
    async ingestFile(filePath) {
        return await this.ingester.ingestFile(filePath);
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
    }
    get ingesterInstance() {
        return this.ingester;
    }
    getTools() {
        return registerKBTools(this);
    }
}
// ============================================================================
// Plugin entry — OpenClaw plugin registration
// ============================================================================
/**
 * Creates the OpenClaw plugin definition.
 * Compatible with both TypeScript source and compiled JS output.
 */
export function createPlugin(ark) {
    return {
        id: "@njuboy11/ark-kb",
        name: "ark-kb",
        description: "🏛️ Ark Knowledge Base — LanceDB + multimodal embedding RAG plugin",
        tools: ark.getTools().map(t => t.name),
    };
}
// ============================================================================
// OpenClaw plugin entry point (CommonJS compat)
// The actual OpenClaw loader looks for `register` or a default-exported
// plugin definition.  We export both patterns for maximum compatibility.
// ============================================================================
export function register(api) {
    const pluginConfig = (api.pluginConfig ?? api.config ?? {});
    const ark = new ArkKB(pluginConfig);
    // Register all tools
    for (const tool of ark.getTools()) {
        api.registerTool(tool);
    }
    // Initialize in background (OpenClaw plugin API doesn't support async activate lifecycle)
    ark.init().catch((err) => console.error('[Ark KB] Background init failed:', err));
    // Register cleanup lifecycle
    api.registerRuntimeLifecycle({
        id: "ark-kb",
        async shutdown() {
            await ark.shutdown();
        },
    });
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