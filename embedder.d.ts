/**
 * Ark KB — Embedder 层
 * 封装多模态 Embedding API 调用（Qwen3-VL-Embedding-8B）
 */
export interface EmbedderConfig {
    apiUrl: string;
    apiKey: string;
    model: string;
    dimensions: number;
}
export declare class Embedder {
    private config;
    constructor(config: EmbedderConfig);
    embed(text: string | string[]): Promise<number[][]>;
}
//# sourceMappingURL=embedder.d.ts.map