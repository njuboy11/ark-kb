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
    providers?: import("./providers/config.js").ResolvedProvider;
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
export declare function getRerankerCapabilities(_model: string): string[];
export declare function resolveRerankerCapabilities(_api: string, _model: string): string[];
export declare function resolveEmbeddingEndpoint(api: string, _model: string, userEndpoint?: string): string;
export declare function resolveEmbeddingBatchSize(_api: string, _model: string): number;
export declare function resolveEmbeddingDimensions(_api: string, _model: string, userDim?: number): number;
export declare function resolveEmbeddingModalities(_api: string, _model: string): string[];
export declare function exposeMediaFile(knowledgePath: string, sourcePath: string): Promise<string>;
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