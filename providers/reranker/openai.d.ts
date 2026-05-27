/**
 * Ark KB — OpenAI-compatible Reranker Provider
 * Covers: SiliconFlow, DashScope, Jina, etc.
 */
import type { ResolvedProvider } from "../config.js";
export interface RerankResult {
    index: number;
    score: number;
}
export declare function openaiRerank(provider: ResolvedProvider, query: string, documents: string[]): Promise<RerankResult[]>;
//# sourceMappingURL=openai.d.ts.map