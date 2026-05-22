/**
 * Ark KB — Configuration Types
 */
import { resolveEmbeddingBatchSize } from "./embedder.js";
export const DEFAULTS = {
    storage: {
        dbPath: "~/.ark-kb/lancedb",
    },
    embedding: {
        api: "siliconflow",
        endpoint: "https://api.siliconflow.cn/v1/embeddings",
        apiKey: "",
        model: "Qwen/Qwen3-VL-Embedding-8B",
        dimensions: 4096,
        batchSize: 16,
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
        params: {},
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
        paths: [],
        debounceMs: 2000,
        ignorePatterns: [".*", "~*", "*.tmp", "*.swp", "*.part"],
    },
};
// ============================================================================
// Auto-detect API protocol from endpoint URL
// ============================================================================
function detectEmbeddingApi(endpoint) {
    const u = endpoint.toLowerCase();
    if (u.includes("siliconflow"))
        return "siliconflow";
    if (u.includes("dashscope") || u.includes("aliyun"))
        return "dashscope";
    if (u.includes("openai"))
        return "openai";
    return "custom";
}
function detectRerankerApi(endpoint, apiKey) {
    if (!apiKey)
        return "none";
    const u = endpoint.toLowerCase();
    if (u.includes("siliconflow"))
        return "siliconflow";
    if (u.includes("cohere"))
        return "cohere";
    return "custom";
}
function detectPdfParserApi(endpoint, apiKey) {
    if (!apiKey)
        return "none";
    const u = endpoint.toLowerCase();
    if (u.includes("mineru"))
        return "mineru";
    return "builtin";
}
// ============================================================================
// Config resolver
// ============================================================================
export function resolveConfig(raw) {
    const embedEndpoint = raw.embedding?.endpoint ?? DEFAULTS.embedding.endpoint;
    const embedModel = raw.embedding?.model ?? DEFAULTS.embedding.model;
    const embedApiKey = raw.embedding?.apiKey ?? process.env.ARK_KB_EMBEDDING_API_KEY ?? DEFAULTS.embedding.apiKey;
    const rerankEndpoint = raw.reranker?.endpoint ?? DEFAULTS.reranker.endpoint;
    const rerankApiKey = raw.reranker?.apiKey ?? process.env.ARK_KB_RERANKER_API_KEY ?? DEFAULTS.reranker.apiKey;
    const pdfEndpoint = raw.pdfParser?.endpoint ?? DEFAULTS.pdfParser.endpoint;
    const pdfApiKey = raw.pdfParser?.apiKey ?? DEFAULTS.pdfParser.apiKey;
    return {
        knowledgePath: raw.knowledgePath ?? process.env.ARK_KB_KNOWLEDGE_PATH ?? "",
        storage: {
            dbPath: raw.storage?.dbPath ?? DEFAULTS.storage.dbPath,
        },
        embedding: {
            api: detectEmbeddingApi(embedEndpoint),
            endpoint: embedEndpoint,
            apiKey: embedApiKey,
            model: embedModel,
            dimensions: raw.embedding?.dimensions ?? DEFAULTS.embedding.dimensions,
            batchSize: resolveEmbeddingBatchSize(embedModel),
        },
        reranker: {
            api: detectRerankerApi(rerankEndpoint, rerankApiKey),
            endpoint: rerankEndpoint,
            apiKey: rerankApiKey,
            model: raw.reranker?.model ?? DEFAULTS.reranker.model,
            minScore: raw.reranker?.minScore ?? DEFAULTS.reranker.minScore,
        },
        pdfParser: {
            api: detectPdfParserApi(pdfEndpoint, pdfApiKey),
            endpoint: pdfEndpoint,
            apiKey: pdfApiKey,
            model: raw.pdfParser?.model ?? DEFAULTS.pdfParser.model,
            params: raw.pdfParser?.params ?? DEFAULTS.pdfParser.params,
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
            paths: raw.watcher?.paths ?? DEFAULTS.watcher.paths,
            debounceMs: raw.watcher?.debounceMs ?? DEFAULTS.watcher.debounceMs,
            ignorePatterns: raw.watcher?.ignorePatterns ?? DEFAULTS.watcher.ignorePatterns,
        },
    };
}
//# sourceMappingURL=config.js.map