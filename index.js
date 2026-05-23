/**
 * Ark KB — Main Entry
 * Wires together all components with nested config support.
 * Exports definePluginEntry-compatible register function for OpenClaw.
 */
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
import { Ingester } from "./ingester.js";
import { Searcher } from "./searcher.js";
import { FileWatcher } from "./watcher.js";
import { resolveConfig, loadConfigFromFile, validateConfig, } from "./config.js";
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
        }, {
            endpoint: this.config.videoSummarizer.endpoint,
            apiKey: this.config.videoSummarizer.apiKey,
            maxFrames: this.config.videoSummarizer.maxFrames,
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
            const result = await this.ingester.heal(kp);
            total = result.healed;
            files = result.healed + result.skipped;
            console.log(`[Ark KB] Healed ${result.healed} files, skipped ${result.skipped}`);
        }
        if (this.config.watcher.enabled && kp) {
            this.watcher.start(kp, async (event, filePath) => {
                const base = filePath.split("/").pop() || filePath;
                if (event === "add" || event === "change") {
                    try {
                        const result = await this.ingester.ingestFile(filePath);
                        if (result.entries === 0 && !result.skipped) {
                            this.markFailed(filePath);
                        }
                    }
                    catch (err) {
                        console.error(`[Ark KB] Watcher ingest error (${filePath}): ${err.message}`);
                        this.markFailed(filePath);
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
        // this._initialized = true;
        console.log(`[Ark KB] Ready — ${total} chunks, ${files} files`);
    }
    failedListPath = "";
    async retryFailed(knowledgePath) {
        const fs = await import("node:fs");
        const path = await import("node:path");
        this.failedListPath = path.join(knowledgePath, ".ark-kb-failed.json");
        if (!fs.existsSync(this.failedListPath))
            return;
        let failed = [];
        try {
            failed = JSON.parse(fs.readFileSync(this.failedListPath, "utf-8"));
        }
        catch {
            return;
        }
        if (failed.length === 0)
            return;
        const remaining = [];
        for (const filePath of failed) {
            try {
                await this.ingester.ingestFile(filePath);
                console.log(`[Ark KB] Retry succeeded: ${path.basename(filePath)}`);
            }
            catch {
                remaining.push(filePath);
            }
        }
        if (remaining.length === 0) {
            fs.unlinkSync(this.failedListPath);
        }
        else {
            fs.writeFileSync(this.failedListPath, JSON.stringify(remaining, null, 2));
        }
    }
    async markFailed(filePath) {
        if (!this.failedListPath)
            return;
        const fs = await import("node:fs");
        let failed = [];
        if (fs.existsSync(this.failedListPath)) {
            try {
                failed = JSON.parse(fs.readFileSync(this.failedListPath, "utf-8"));
            }
            catch { }
        }
        if (!failed.includes(filePath)) {
            failed.push(filePath);
            fs.writeFileSync(this.failedListPath, JSON.stringify(failed, null, 2));
        }
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
    // ── Config loading ──────────────────────────────────────────
    // Priority: 1. plugin-config.json (standalone)  2. openclaw.json (fallback)
    const pluginDir = import.meta.dirname;
    const standalonePath = join(pluginDir, "plugin-config.json");
    const fileResult = loadConfigFromFile(standalonePath);
    if (fileResult.errors.length > 0) {
        // Standalone file exists but is invalid → fail hard
        console.error("[Ark KB] Config validation FAILED in", standalonePath);
        for (const err of fileResult.errors) {
            console.error(`  - ${err}`);
        }
        throw new Error(`[Ark KB] Configuration error in ${standalonePath}: ${fileResult.errors.join("; ")}`);
    }
    let arkConfig;
    let fromOpenClaw = false;
    if (fileResult.config) {
        console.log("[Ark KB] Loading config from standalone file:", standalonePath);
        arkConfig = fileResult.config;
    }
    else {
        // No standalone file → try to auto-create from example, then fall back to openclaw.json
        const examplePath = join(pluginDir, "plugin-config.example.json");
        if (existsSync(examplePath)) {
            console.log("[Ark KB] No standalone config found, auto-creating from example:", examplePath);
            copyFileSync(examplePath, standalonePath);
            console.log("[Ark KB] Created", standalonePath, "— edit this file to configure.");
            const retry = loadConfigFromFile(standalonePath);
            if (retry.config) {
                arkConfig = retry.config;
            }
            else {
                console.log("[Ark KB] Falling back to openclaw.json");
                arkConfig = (api.pluginConfig ?? api.config ?? {});
                fromOpenClaw = true;
            }
        }
        else {
            console.log("[Ark KB] No config files found, falling back to openclaw.json");
            arkConfig = (api.pluginConfig ?? api.config ?? {});
            fromOpenClaw = true;
        }
    }
    // Validate fallback config when loaded from openclaw.json
    if (fromOpenClaw) {
        const fallbackErrors = validateConfig(arkConfig);
        if (fallbackErrors.length > 0) {
            console.error("[Ark KB] Config validation FAILED (openclaw.json):");
            for (const err of fallbackErrors) {
                console.error(`  - ${err}`);
            }
            throw new Error(`[Ark KB] Configuration error in openclaw.json: ${fallbackErrors.join("; ")}`);
        }
    }
    const ark = new ArkKB(arkConfig);
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