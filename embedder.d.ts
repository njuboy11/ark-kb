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
export declare function resolveEmbeddingBatchSize(api: string, model: string): number;
export declare function resolveEmbeddingDimensions(api: string, model: string, userDim?: number): number;
export declare function resolveEmbeddingEndpoint(api: string, model: string, userEndpoint?: string): string;
export declare class Embedder {
    private config;
    constructor(config: EmbedderConfig);
    embed(texts: string | string[]): Promise<number[][]>;
    private embedBatchWithRetry;
    private embedBatch;
    private parseResponse;
}
//# sourceMappingURL=embedder.d.ts.map