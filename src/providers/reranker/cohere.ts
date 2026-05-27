/**
 * Ark KB — Cohere Reranker Provider
 */

import type { ResolvedProvider } from "../config.js";
import type { RerankResult } from "./openai.js";

export async function cohereRerank(
  provider: ResolvedProvider,
  query: string,
  documents: string[]
): Promise<RerankResult[]> {
  const response = await fetch(provider.url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model.id,
      query,
      documents,
      top_n: documents.length,
      return_documents: false,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Cohere reranker error (${response.status}): ${err}`);
  }

  const data = (await response.json()) as any;

  if (data.results && Array.isArray(data.results)) {
    return data.results.map(
      (r: any): RerankResult => ({
        index: r.index,
        score: r.relevance_score ?? r.score ?? 0,
      })
    );
  }

  return [];
}
