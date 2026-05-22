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
        batchSize?: number;
    };
    reranker?: {
        endpoint?: string;
        apiKey?: string;
        model?: string;
        minScore?: number;
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
        api: "siliconflow" | "cohere" | "custom" | "none";
        endpoint: string;
        apiKey: string;
        model: string;
        minScore: number;
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
}
export declare const DEFAULTS: Omit<ResolvedConfig, "knowledgePath">;
export declare function resolveConfig(raw: ArkKBConfig): ResolvedConfig;
//# sourceMappingURL=config.d.ts.map