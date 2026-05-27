/**
 * Ark KB — Reranker Router
 */

import { detectProtocol } from "../detector.js";
import type { ResolvedProvider } from "../config.js";
import type { RerankResult } from "./openai.js";
import { openaiRerank } from "./openai.js";
import { cohereRerank } from "./cohere.js";

export type { RerankResult } from "./openai.js";

export async function rerank(
  provider: ResolvedProvider,
  query: string,
  documents: string[]
): Promise<RerankResult[]> {
  const protocol = detectProtocol(provider.url);

  switch (protocol) {
    case "cohere":
      return cohereRerank(provider, query, documents);
    case "openai":
    default:
      return openaiRerank(provider, query, documents);
  }
}

export { openaiRerank, cohereRerank };
