/**
 * Ark KB — Embedder
 * Multi-provider embedding: qwen3-vl (DashScope), openai-compatible, custom.
 */
export interface EmbedderConfig {
    api: "qwen3-vl" | "openai" | "custom";
    endpoint: string;
    apiKey: string;
    model: string;
    dimensions: number;
    batchSize: number;
}
export declare class Embedder {
    private config;
    private maxRetries;
    constructor(config: EmbedderConfig);
    /**
     * Embed a single text or a batch of texts.
     * Returns an array of embedding vectors.
     */
    embed(text: string | string[]): Promise<number[][]>;
    private callEmbeddingAPI;
    private buildRequestBody;
    private buildHeaders;
    private parseResponse;
}
//# sourceMappingURL=embedder.d.ts.map