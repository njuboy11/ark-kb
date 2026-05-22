/**
 * Ark KB — Configuration Types
 */
export interface ArkKBConfig {
    knowledgePath?: string;
    storage?: {
        dbPath?: string;
    };
    embedding?: {
        endpoint?: string;
        apiKey?: string;
        model?: string;
        dimensions?: number;
    };
    reranker?: {
        /** Set to false to disable reranking entirely */
        enabled?: boolean;
        endpoint?: string;
        apiKey?: string;
        model?: string;
        minScore?: number;
        multimodal?: {
            endpoint?: string;
            apiKey?: string;
            model?: string;
        };
    };
    pdfParser?: {
        endpoint?: string;
        apiKey?: string;
        model?: string;
        params?: Record<string, any>;
    };
    search?: {
        vectorWeight?: number;
        topK?: number;
        resultCount?: number;
        bm25Enabled?: boolean;
        fusionMethod?: "min_max" | "z_score" | "rrf" | "raw";
    };
    chunking?: {
        maxTokens?: number;
        overlapTokens?: number;
        strategy?: "paragraph" | "fixed" | "sentence";
    };
    watcher?: {
        enabled?: boolean;
        paths?: string[];
        debounceMs?: number;
        ignorePatterns?: string[];
    };
    /** Video summarization via VLM (e.g. MiniMax /v1/coding_plan/vlm) */
    videoSummarizer?: {
        enabled?: boolean;
        provider?: string;
        endpoint?: string;
        apiKey?: string;
        /** Max frames to send to VLM (default 100) */
        maxFrames?: number;
    };
}
export interface ResolvedConfig {
    knowledgePath: string;
    storage: {
        dbPath: string;
    };
    embedding: {
        api: "dashscope" | "siliconflow" | "openai" | "custom";
        endpoint: string;
        apiKey: string;
        model: string;
        dimensions: number;
        batchSize: number;
    };
    reranker: {
        enabled: boolean;
        api: "siliconflow" | "cohere" | "custom" | "none";
        endpoint: string;
        apiKey: string;
        model: string;
        minScore: number;
        multimodal?: {
            endpoint?: string;
            apiKey?: string;
            model?: string;
        };
    };
    pdfParser: {
        api: "mineru" | "builtin" | "none";
        endpoint: string;
        apiKey: string;
        model: string;
        params: Record<string, any>;
    };
    search: {
        vectorWeight: number;
        topK: number;
        resultCount: number;
        bm25Enabled: boolean;
        fusionMethod: "min_max" | "z_score" | "rrf" | "raw";
    };
    chunking: {
        maxTokens: number;
        overlapTokens: number;
        strategy: "paragraph" | "fixed" | "sentence";
    };
    watcher: {
        enabled: boolean;
        paths: string[];
        debounceMs: number;
        ignorePatterns: string[];
    };
    videoSummarizer: {
        enabled: boolean;
        endpoint: string;
        apiKey: string;
        maxFrames: number;
    };
}
export declare const DEFAULTS: Omit<ResolvedConfig, "knowledgePath">;
export declare function resolveConfig(raw: ArkKBConfig): ResolvedConfig;
//# sourceMappingURL=config.d.ts.map