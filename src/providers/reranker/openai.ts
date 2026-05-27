/**
 * Ark KB — OpenAI-compatible Reranker Provider
 * Covers: SiliconFlow, DashScope, Jina, etc.
 */

import type { ResolvedProvider } from "../config.js";

export interface RerankResult {
  index: number;
  score: number;
}

export async function openaiRerank(
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
      return_documents: false,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI reranker error (${response.status}): ${err}`);
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
