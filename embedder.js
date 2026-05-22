/**
 * Ark KB — Embedder
 * Multi-API embedder supporting DashScope, SiliconFlow, OpenAI, and custom endpoints.
 * Batch embedding with configurable batch size and exponential backoff retries.
 */
const EMBEDDING_MODEL_PRESETS = {
    // DashScope / Alibaba
    "text-embedding-v4": { batchSize: 10, dimensions: 2048 },
    "text-embedding-v3": { batchSize: 10, dimensions: 2048 },
    "text-embedding-v2": { batchSize: 10, dimensions: 1536 },
    // SiliconFlow multimodal
    "Qwen/Qwen3-VL-Embedding-8B": {
        batchSize: 16,
        endpoint: "https://api.siliconflow.cn/v1/embeddings",
        dimensions: 4096,
    },
    // OpenAI
    "text-embedding-3-large": { batchSize: 2048, dimensions: 3072 },
    "text-embedding-3-small": { batchSize: 2048, dimensions: 1536 },
    "text-embedding-ada-002": { batchSize: 2048, dimensions: 1536 },
};
/** Resolve batch size from model registry, falling back to config or default */
export function resolveEmbeddingBatchSize(model) {
    const preset = EMBEDDING_MODEL_PRESETS[model];
    if (preset)
        return preset.batchSize;
    return 16; // conservative default
}
/** Resolve dimensions from model registry */
export function resolveEmbeddingDimensions(model, userDim) {
    if (userDim)
        return userDim;
    const preset = EMBEDDING_MODEL_PRESETS[model];
    if (preset?.dimensions)
        return preset.dimensions;
    return 2048; // conservative default
}
/** Resolve endpoint from model registry (user > registry > default) */
export function resolveEmbeddingEndpoint(model, userEndpoint) {
    if (userEndpoint)
        return userEndpoint;
    const preset = EMBEDDING_MODEL_PRESETS[model];
    if (preset?.endpoint)
        return preset.endpoint;
    return "https://api.siliconflow.cn/v1/embeddings";
}
// ============================================================================
// Embedder
// ============================================================================
export class Embedder {
    config;
    constructor(config) {
        this.config = config;
    }
    /**
     * Embed a single text or a batch of texts.
     * Automatically splits into batchSize chunks and merges results.
     */
    async embed(texts) {
        const inputs = (Array.isArray(texts) ? texts : [texts]).filter(s => s.trim().length > 0);
        if (inputs.length === 0)
            return [];
        const allEmbeddings = [];
        // Process in batches
        const batchSize = this.config.batchSize;
        for (let i = 0; i < inputs.length; i += batchSize) {
            const batch = inputs.slice(i, i + batchSize);
            const result = await this.embedBatchWithRetry(batch);
            for (const emb of result.embeddings) {
                allEmbeddings.push(emb);
            }
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
        const headers = {
            "Content-Type": "application/json",
        };
        let body;
        switch (api) {
            case "dashscope":
                // DashScope /compatible-mode endpoint uses OpenAI-compatible flat format
                if (endpoint.includes("compatible-mode")) {
                    headers["Authorization"] = `Bearer ${apiKey}`;
                    body = { model, input: inputs, dimensions };
                }
                else {
                    // Native DashScope endpoint: nested documents format
                    headers["Authorization"] = `Bearer ${apiKey}`;
                    headers["x-knx-domain"] = "search";
                    body = {
                        model,
                        input: { documents: inputs.map(text => ({ text })) },
                        parameters: { dimensions },
                    };
                }
                break;
            case "siliconflow":
            case "openai":
            case "custom":
                headers["Authorization"] = `Bearer ${apiKey}`;
                body = {
                    model,
                    input: inputs,
                    dimensions,
                };
                break;
            default:
                throw new Error(`[Ark KB] Unknown embedding API: ${api}`);
        }
        const response = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const errText = await response.text().catch(() => "");
            throw new Error(`Embedding API error (${response.status}): ${errText}`);
        }
        const data = await response.json();
        return this.parseResponse(data, api);
    }
    /**
     * Parse API-specific response format into standard embedding arrays.
     * All formats return OpenAI-compatible `data[index].embedding` arrays.
     */
    parseResponse(data, api) {
        // OpenAI / SiliconFlow format
        if (data.data && Array.isArray(data.data)) {
            const embeddings = data.data
                .sort((a, b) => a.index - b.index)
                .map((item) => item.embedding);
            return {
                embeddings,
                model: data.model || this.config.model,
                usage: data.usage ? {
                    prompt_tokens: data.usage.prompt_tokens || 0,
                    total_tokens: data.usage.total_tokens || 0,
                } : undefined,
            };
        }
        // DashScope format: { output.embeddings: [{ embedding: number[], text_index: number }] }
        if (data.output?.embeddings && Array.isArray(data.output.embeddings)) {
            const embeddings = data.output.embeddings
                .sort((a, b) => a.text_index - b.text_index)
                .map((item) => item.embedding);
            return {
                embeddings,
                model: data.model || this.config.model,
                usage: data.usage,
            };
        }
        throw new Error(`[Ark KB] Unexpected embedding response format from ${api}: ${JSON.stringify(Object.keys(data))}`);
    }
}
// ============================================================================
// Helpers
// ============================================================================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//# sourceMappingURL=embedder.js.map