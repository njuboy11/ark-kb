/**
 * Ark KB — Reranker Router
 */
import type { ResolvedProvider } from "../config.js";
import type { RerankResult } from "./openai.js";
import { openaiRerank } from "./openai.js";
import { cohereRerank } from "./cohere.js";
export type { RerankResult } from "./openai.js";
export declare function rerank(provider: ResolvedProvider, query: string, documents: string[]): Promise<RerankResult[]>;
export { openaiRerank, cohereRerank };
//# sourceMappingURL=index.d.ts.map