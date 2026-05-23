/**
 * Ark KB — Embedder
 * Multi-API embedder supporting DashScope, SiliconFlow, OpenAI, and custom endpoints.
 * Batch embedding with configurable batch size and exponential backoff retries.
 */
// ============================================================================
// Model capabilities registry
// ============================================================================
/** Supported input modalities per embedding model */
const MODEL_CAPABILITIES = {
    "text-embedding-v4": ["text"],
    "text-embedding-v3": ["text"],
    "text-embedding-v2": ["text"],
    "Qwen/Qwen3-VL-Embedding-8B": ["text", "image"],
    "text-embedding-3-large": ["text"],
    "text-embedding-3-small": ["text"],
    "text-embedding-ada-002": ["text"],
};
/** Get the modalities supported by an embedding model. Defaults to ["text"]. */
export function getModelCapabilities(model) {
    return MODEL_CAPABILITIES[model] ?? ["text"];
}
/** Reranker model capabilities */
const RERANKER_MODEL_CAPABILITIES = {
    "Qwen/Qwen3-Reranker-8B": ["text"],
    "BAAI/bge-reranker-v2-m3": ["text"],
    "Qwen/Qwen3-VL-Reranker-8B": ["text", "image"],
};
/** Get the modalities supported by a reranker model. Defaults to ["text"]. */
export function getRerankerCapabilities(model) {
    return RERANKER_MODEL_CAPABILITIES[model] ?? ["text"];
}
const EMBEDDING_MODEL_PRESETS = {
    dashscope: {
        "text-embedding-v4": { batchSize: 10, endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings", dimensions: 2048, modalities: ["text"] },
        "text-embedding-v3": { batchSize: 10, dimensions: 2048, modalities: ["text"] },
        "text-embedding-v2": { batchSize: 10, dimensions: 1536, modalities: ["text"] },
    },
    siliconflow: {
        "Qwen/Qwen3-VL-Embedding-8B": { batchSize: 16, endpoint: "https://api.siliconflow.cn/v1/embeddings", dimensions: 4096, modalities: ["text", "image"] },
    },
    openai: {
        "text-embedding-3-large": { batchSize: 2048, dimensions: 3072, modalities: ["text"] },
        "text-embedding-3-small": { batchSize: 2048, dimensions: 1536, modalities: ["text"] },
        "text-embedding-ada-002": { batchSize: 2048, dimensions: 1536, modalities: ["text"] },
    },
};
function getPreset(api, model) {
    return EMBEDDING_MODEL_PRESETS[api]?.[model];
}
export function resolveEmbeddingBatchSize(api, model) {
    return getPreset(api, model)?.batchSize ?? 16;
}
export function resolveEmbeddingDimensions(api, model, userDim) {
    if (userDim)
        return userDim;
    return getPreset(api, model)?.dimensions ?? 2048;
}
export function resolveEmbeddingEndpoint(api, model, userEndpoint) {
    if (userEndpoint)
        return userEndpoint;
    return getPreset(api, model)?.endpoint ?? "https://api.siliconflow.cn/v1/embeddings";
}
/** Supported modalities from model registry, defaults to text-only */
export function resolveEmbeddingModalities(api, model) {
    return getPreset(api, model)?.modalities ?? ["text"];
}
/** Resolve reranker capabilities by API + model name */
export function resolveRerankerCapabilities(api, model) {
    const apiLower = api.toLowerCase();
    if (apiLower === "siliconflow") {
        return RERANKER_MODEL_PRESETS.siliconflow?.[model]?.modalities ?? getRerankerCapabilities(model);
    }
    if (apiLower === "cohere") {
        return RERANKER_MODEL_PRESETS.cohere?.[model]?.modalities ?? getRerankerCapabilities(model);
    }
    return getRerankerCapabilities(model);
}
const RERANKER_MODEL_PRESETS = {
    siliconflow: {
        "BAAI/bge-reranker-v2-m3": {
            endpoint: "https://api.siliconflow.cn/v1/rerank",
            model: "BAAI/bge-reranker-v2-m3",
            minScore: 0.35,
            modalities: ["text"],
        },
        "Qwen/Qwen3-Reranker-8B": {
            endpoint: "https://api.siliconflow.cn/v1/rerank",
            model: "Qwen/Qwen3-Reranker-8B",
            minScore: 0.1,
            modalities: ["text"],
        },
        "Qwen/Qwen3-VL-Reranker-8B": {
            endpoint: "https://api.siliconflow.cn/v1/rerank",
            model: "Qwen/Qwen3-VL-Reranker-8B",
            minScore: 0.1,
            modalities: ["text", "image"],
        },
    },
    cohere: {
        "rerank-multilingual-v3.0": {
            endpoint: "https://api.cohere.ai/v1/rerank",
            model: "rerank-multilingual-v3.0",
            minScore: 0.35,
            modalities: ["text"],
        },
    },
};
// ============================================================================
// Media file exposure — for multimodal APIs that need HTTPS URL or base64
// ============================================================================
import { copyFile, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync, chmodSync } from "node:fs";
/** Expose a local file as HTTPS URL (if nginx available) or base64. */
export async function exposeMediaFile(knowledgePath, sourcePath) {
    const serveDir = "/var/www/downloads";
    const baseName = basename(sourcePath);
    // If nginx serve dir exists → copy + HTTPS URL (best performance)
    if (existsSync(serveDir)) {
        try {
            const dest = join(serveDir, baseName);
            await copyFile(join(knowledgePath, sourcePath), dest);
            chmodSync(dest, 0o644);
            return `https://home.sfunds.cn:8444/${encodeURIComponent(baseName)}`;
        }
        catch { /* fall through to base64 */ }
    }
    // Fallback: base64 encode (works everywhere, no server needed)
    try {
        const fileBuffer = await readFile(join(knowledgePath, sourcePath));
        return fileBuffer.toString("base64");
    }
    catch {
        return "";
    }
}
// ============================================================================
// Embedder
// ============================================================================
export class Embedder {
    config;
    constructor(config) {
        this.config = config;
    }
    /** Check if this model supports a given input modality */
    supportsModality(kind) {
        return resolveEmbeddingModalities(this.config.api, this.config.model).includes(kind);
    }
    async embed(texts) {
        const inputs = (Array.isArray(texts) ? texts : [texts]).filter(s => s.trim().length > 0);
        if (inputs.length === 0)
            return [];
        const batchSize = this.config.batchSize;
        const allEmbeddings = [];
        for (let i = 0; i < inputs.length; i += batchSize) {
            const batch = inputs.slice(i, i + batchSize);
            const result = await this.embedBatchWithRetry(batch);
            for (const emb of result.embeddings)
                allEmbeddings.push(emb);
        }
        return allEmbeddings;
    }
    async embedBatchWithRetry(inputs, attempt = 0) {
        const maxAttempts = 3;
        try {
            return await this.embedBatch(inputs);
        }
        catch (err) {
            if (attempt < maxAttempts - 1) {
                const delay = Math.pow(2, attempt) * 1000;
                console.warn(`[Ark KB] Embedding batch failed (attempt ${attempt + 1}), retrying in ${delay}ms: ${err.message}`);
                await sleep(delay);
                return this.embedBatchWithRetry(inputs, attempt + 1);
            }
            throw new Error(`[Ark KB] Embedding failed after ${maxAttempts} attempts: ${err.message}`);
        }
    }
    async embedBatch(inputs) {
        const { api, endpoint, apiKey, model, dimensions } = this.config;
        const headers = { "Content-Type": "application/json" };
        let body;
        switch (api) {
            case "dashscope":
                if (endpoint.includes("compatible-mode")) {
                    headers["Authorization"] = `Bearer ${apiKey}`;
                    body = { model, input: inputs, dimensions };
                }
                else {
                    headers["Authorization"] = `Bearer ${apiKey}`;
                    headers["x-knx-domain"] = "search";
                    body = { model, input: { documents: inputs.map(text => ({ text })) }, parameters: { dimensions } };
                }
                break;
            case "siliconflow":
            case "openai":
            case "custom":
                headers["Authorization"] = `Bearer ${apiKey}`;
                body = { model, input: inputs, dimensions };
                break;
            default:
                throw new Error(`[Ark KB] Unknown embedding API: ${api}`);
        }
        const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
        if (!response.ok) {
            const errText = await response.text().catch(() => "");
            throw new Error(`Embedding API error (${response.status}): ${errText}`);
        }
        const data = await response.json();
        return this.parseResponse(data, api);
    }
    parseResponse(data, api) {
        if (data.data && Array.isArray(data.data)) {
            const embeddings = data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
            return { embeddings, model: data.model || this.config.model, usage: data.usage ? { prompt_tokens: data.usage.prompt_tokens || 0, total_tokens: data.usage.total_tokens || 0 } : undefined };
        }
        if (data.output?.embeddings && Array.isArray(data.output.embeddings)) {
            const embeddings = data.output.embeddings.sort((a, b) => a.text_index - b.text_index).map((item) => item.embedding);
            return { embeddings, model: data.model || this.config.model, usage: data.usage };
        }
        throw new Error(`[Ark KB] Unexpected embedding response format from ${api}: ${JSON.stringify(Object.keys(data))}`);
    }
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//# sourceMappingURL=embedder.js.map