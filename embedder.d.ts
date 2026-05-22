/**
 * Ark KB — Embedder
 * Multi-API embedder supporting DashScope, SiliconFlow, OpenAI, and custom endpoints.
 * Batch embedding with configurable batch size and exponential backoff retries.
 */
export interface EmbedderConfig {
    api: string;
    endpoint: string;
    apiKey: string;
    model: string;
    dimensions: number;
    batchSize: number;
}
export interface EmbedResult {
    embeddings: number[][];
    model: string;
    usage?: {
        prompt_tokens: number;
        total_tokens: number;
    };
}
/** Resolve batch size from model registry, falling back to config or default */
export declare function resolveEmbeddingBatchSize(model: string, configBatchSize?: number): number;
export declare class Embedder {
    private config;
    constructor(config: EmbedderConfig);
    /**
     * Embed a single text or a batch of texts.
     * Automatically splits into batchSize chunks and merges results.
     */
    embed(texts: string | string[]): Promise<number[][]>;
    private embedBatchWithRetry;
    private embedBatch;
    /**
     * Parse API-specific response format into standard embedding arrays.
     * All formats return OpenAI-compatible `data[index].embedding` arrays.
     */
    private parseResponse;
}
//# sourceMappingURL=embedder.d.ts.map