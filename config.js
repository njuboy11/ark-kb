/**
 * Ark KB — Configuration Types
 */
export const DEFAULTS = {
    storage: {
        dbPath: "~/.ark-kb/lancedb",
    },
    embedding: {
        api: "qwen3-vl",
        endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
        apiKey: "",
        model: "Qwen3-VL-Embedding-8B",
        dimensions: 4096,
        batchSize: 8,
    },
    reranker: {
        api: "none",
        endpoint: "https://api.siliconflow.cn/v1/rerank",
        apiKey: "",
        model: "BAAI/bge-reranker-v2-m3",
        minScore: 0.35,
    },
    pdfParser: {
        api: "none",
        endpoint: "",
        apiKey: "",
        model: "precise-v4",
    },
    search: {
        vectorWeight: 0.7,
        topK: 20,
        resultCount: 6,
        bm25Enabled: true,
        fusionMethod: "min_max",
    },
    chunking: {
        maxTokens: 400,
        overlapTokens: 50,
        strategy: "paragraph",
    },
    watcher: {
        enabled: true,
        debounceMs: 2000,
        ignorePatterns: [".*", "~*", "*.tmp", "*.swp", "*.part"],
    },
};
export function resolveConfig(raw) {
    return {
        knowledgePath: raw.knowledgePath ?? "",
        storage: {
            dbPath: raw.storage?.dbPath ?? DEFAULTS.storage.dbPath,
        },
        embedding: {
            api: raw.embedding?.api ?? DEFAULTS.embedding.api,
            endpoint: raw.embedding?.endpoint ?? DEFAULTS.embedding.endpoint,
            apiKey: raw.embedding?.apiKey ?? DEFAULTS.embedding.apiKey,
            model: raw.embedding?.model ?? DEFAULTS.embedding.model,
            dimensions: raw.embedding?.dimensions ?? DEFAULTS.embedding.dimensions,
            batchSize: raw.embedding?.batchSize ?? DEFAULTS.embedding.batchSize,
        },
        reranker: {
            api: raw.reranker?.api ?? DEFAULTS.reranker.api,
            endpoint: raw.reranker?.endpoint ?? DEFAULTS.reranker.endpoint,
            apiKey: raw.reranker?.apiKey ?? DEFAULTS.reranker.apiKey,
            model: raw.reranker?.model ?? DEFAULTS.reranker.model,
            minScore: raw.reranker?.minScore ?? DEFAULTS.reranker.minScore,
        },
        pdfParser: {
            api: raw.pdfParser?.api ?? DEFAULTS.pdfParser.api,
            endpoint: raw.pdfParser?.endpoint ?? DEFAULTS.pdfParser.endpoint,
            apiKey: raw.pdfParser?.apiKey ?? DEFAULTS.pdfParser.apiKey,
            model: raw.pdfParser?.model ?? DEFAULTS.pdfParser.model,
        },
        search: {
            vectorWeight: raw.search?.vectorWeight ?? DEFAULTS.search.vectorWeight,
            topK: raw.search?.topK ?? DEFAULTS.search.topK,
            resultCount: raw.search?.resultCount ?? DEFAULTS.search.resultCount,
            bm25Enabled: raw.search?.bm25Enabled ?? DEFAULTS.search.bm25Enabled,
            fusionMethod: raw.search?.fusionMethod ?? DEFAULTS.search.fusionMethod,
        },
        chunking: {
            maxTokens: raw.chunking?.maxTokens ?? DEFAULTS.chunking.maxTokens,
            overlapTokens: raw.chunking?.overlapTokens ?? DEFAULTS.chunking.overlapTokens,
            strategy: raw.chunking?.strategy ?? DEFAULTS.chunking.strategy,
        },
        watcher: {
            enabled: raw.watcher?.enabled ?? DEFAULTS.watcher.enabled,
            debounceMs: raw.watcher?.debounceMs ?? DEFAULTS.watcher.debounceMs,
            ignorePatterns: raw.watcher?.ignorePatterns ?? DEFAULTS.watcher.ignorePatterns,
        },
    };
}
//# sourceMappingURL=config.js.map