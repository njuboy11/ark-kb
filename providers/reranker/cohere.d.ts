/**
 * Ark KB — Cohere Reranker Provider
 */
import type { ResolvedProvider } from "../config.js";
import type { RerankResult } from "./openai.js";
export declare function cohereRerank(provider: ResolvedProvider, query: string, documents: string[]): Promise<RerankResult[]>;
//# sourceMappingURL=cohere.d.ts.map