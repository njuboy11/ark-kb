/**
 * Ark KB — Main Entry
 * 🏛️ Ark Knowledge Base — 基于 LanceDB + 多模态 Embedding 的个人知识库
 */
import { join } from "node:path";
import { registerKBTools } from "./tools.js";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
import { Ingester } from "./ingester.js";
import { Searcher } from "./searcher.js";
import { FileWatcher } from "./watcher.js";
export const DEFAULTS = {
    dbPath: join(homedir(), ".ark-kb", "lancedb"),
    embeddingApiUrl: "https://api.siliconflow.cn/v1/embeddings",
    embeddingApiKey: "",
    embeddingModel: "Qwen3-VL-Embedding-8B",
    vectorDim: 4096,
    enableWatcher: true,
    rerankerEnabled: false,
    searchTopK: 20,
    rerankerMinScore: 0.35,
    resultCount: 6,
};
// ============================================================================
// ArkKB — 主入口类
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
        this.config = { ...DEFAULTS, ...config };
        // 确保路径存在
        if (!existsSync(this.config.knowledgePath)) {
            mkdirSync(this.config.knowledgePath, { recursive: true });
        }
        const dbDir = this.config.dbPath ? dir(this.config.dbPath) : join(homedir(), ".ark-kb");
        if (!existsSync(dbDir)) {
            mkdirSync(dbDir, { recursive: true });
        }
        // 核心组件
        this.store = new KnowledgeStore({
            dbPath: this.config.dbPath,
            vectorDim: this.config.vectorDim,
        });
        this.embedder = new Embedder({
            apiUrl: this.config.embeddingApiUrl,
            apiKey: this.config.embeddingApiKey,
            model: this.config.embeddingModel,
            dimensions: this.config.vectorDim,
        });
        this.ingester = new Ingester(this.store, this.embedder);
        this.searcher = new Searcher(this.store, this.embedder, this.config.knowledgePath);
        this.watcher = new FileWatcher();
    }
    async init() {
        if (this.initialized)
            return;
        // 1. 初始化 LanceDB
        console.log("[Ark KB] 初始化 LanceDB...");
        await this.store.init();
        // 2. 扫描已有文件
        console.log("[Ark KB] 扫描知识库文件夹...");
        const { total, files } = await this.ingester.ingestDirectory(this.config.knowledgePath);
        console.log(`[Ark KB] 已索引 ${files} 文件，共 ${total} 个 chunk`);
        // 3. 启动文件监听
        if (this.config.enableWatcher) {
            this.watcher.start(this.config.knowledgePath, async (event, filePath) => {
                if (event === "add" || event === "change") {
                    await this.ingester.ingestFile(filePath);
                }
                else if (event === "unlink") {
                    const base = filePath.split("/").pop() || filePath;
                    const deleted = await this.store.deleteBySource(base);
                    console.log(`[Ark KB] 已清理: ${base} (${deleted} chunks)`);
                }
            });
        }
        this.initialized = true;
        console.log(`[Ark KB] ✅ 知识库就绪 (${total} chunks, ${files} 文件)`);
    }
    // ========================================================================
    // 对外接口
    // ========================================================================
    async search(query, options) {
        const searchOptions = {
            query,
            topK: options?.topK ?? this.config.searchTopK,
            rerankerEnabled: options?.rerankerEnabled ?? this.config.rerankerEnabled,
            rerankerMinScore: options?.rerankerMinScore ?? this.config.rerankerMinScore,
            resultCount: options?.resultCount ?? this.config.resultCount,
        };
        return await this.searcher.search(searchOptions);
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
        console.log("[Ark KB] 已关闭");
    }
    /**
     * 获取 OpenClaw 工具注册列表
     */
    getTools() {
        return registerKBTools(this);
    }
}
function dir(p) {
    const i = p.lastIndexOf("/");
    return i >= 0 ? p.slice(0, i) : ".";
}
//# sourceMappingURL=index.js.map