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
/** Get the modalities supported by an embedding model. Defaults to ["text"]. */
export declare function getModelCapabilities(model: string): string[];
/** Get the modalities supported by a reranker model. Defaults to ["text"]. */
export declare function getRerankerCapabilities(model: string): string[];
export declare function resolveEmbeddingBatchSize(api: string, model: string): number;
export declare function resolveEmbeddingDimensions(api: string, model: string, userDim?: number): number;
export declare function resolveEmbeddingEndpoint(api: string, model: string, userEndpoint?: string): string;
/** Supported modalities from model registry, defaults to text-only */
export declare function resolveEmbeddingModalities(api: string, model: string): string[];
/** Resolve reranker capabilities by API + model name */
export declare function resolveRerankerCapabilities(api: string, model: string): string[];
/** Expose a local file as HTTPS URL (if nginx available) or base64. */
export declare function exposeMediaFile(knowledgePath: string, sourcePath: string): Promise<string>;
/** Clean up a previously exposed nginx-served file after processing is complete. */
export declare function cleanupExposedMedia(sourcePath: string): Promise<void>;
export declare class Embedder {
    private config;
    constructor(config: EmbedderConfig);
    /** Check if this model supports a given input modality */
    supportsModality(kind: string): boolean;
    embed(texts: string | string[]): Promise<number[][]>;
    private embedBatchWithRetry;
    private embedBatch;
    private parseResponse;
}
//# sourceMappingURL=embedder.d.ts.map