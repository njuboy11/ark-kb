/**
 * Ark KB — Embedder
 * Multi-provider embedding: qwen3-vl (DashScope), openai-compatible, custom.
 */
// ============================================================================
// Embedder
// ============================================================================
export class Embedder {
    config;
    maxRetries = 3;
    constructor(config) {
        this.config = config;
    }
    /**
     * Embed a single text or a batch of texts.
     * Returns an array of embedding vectors.
     */
    async embed(text) {
        const inputs = Array.isArray(text) ? text : [text];
        if (inputs.length === 0)
            return [];
        const results = [];
        // Process in batches
        for (let i = 0; i < inputs.length; i += this.config.batchSize) {
            const batch = inputs.slice(i, i + this.config.batchSize);
            const batchResults = await this.callEmbeddingAPI(batch);
            results.push(...batchResults);
        }
        return results;
    }
    async callEmbeddingAPI(inputs) {
        let lastError = null;
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            try {
                const body = this.buildRequestBody(inputs);
                const response = await fetch(this.config.endpoint, {
                    method: "POST",
                    headers: this.buildHeaders(),
                    body: JSON.stringify(body),
                });
                if (response.status === 429 || response.status === 503) {
                    // Rate limit or unavailable — retry after delay
                    const retryAfter = response.headers.get("Retry-After");
                    const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : (attempt + 1) * 1000;
                    await sleep(delay);
                    continue;
                }
                if (!response.ok) {
                    const errBody = await response.text();
                    throw new Error(`Embedding API error (${response.status}): ${errBody}`);
                }
                const data = await response.json();
                return this.parseResponse(data, inputs.length);
            }
            catch (err) {
                lastError = err;
                if (attempt < this.maxRetries - 1) {
                    await sleep((attempt + 1) * 500);
                }
            }
        }
        throw lastError ?? new Error("Embedding failed after retries");
    }
    buildRequestBody(inputs) {
        switch (this.config.api) {
            case "qwen3-vl":
                return {
                    model: this.config.model,
                    input: inputs,
                    dimensions: this.config.dimensions,
                };
            case "openai":
                return {
                    model: this.config.model,
                    input: inputs,
                    dimensions: this.config.dimensions,
                };
            case "custom":
            default:
                return {
                    model: this.config.model,
                    input: inputs,
                    dimensions: this.config.dimensions,
                };
        }
    }
    buildHeaders() {
        const headers = {
            "Content-Type": "application/json",
        };
        if (this.config.apiKey) {
            headers["Authorization"] = `Bearer ${this.config.apiKey}`;
        }
        return headers;
    }
    parseResponse(data, expectedCount) {
        // Standard OpenAI-compatible response
        if (data.data && Array.isArray(data.data)) {
            const sorted = data.data.slice().sort((a, b) => a.index - b.index);
            return sorted.map((item) => item.embedding);
        }
        // Alternative: data.embeddings array (some providers)
        if (data.embeddings && Array.isArray(data.embeddings)) {
            return data.embeddings.map((item) => Array.isArray(item) ? item : item.embedding ?? []);
        }
        throw new Error(`Unexpected embedding response format: ${JSON.stringify(data).slice(0, 200)}`);
    }
}
// ============================================================================
// Helper
// ============================================================================
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=embedder.js.map