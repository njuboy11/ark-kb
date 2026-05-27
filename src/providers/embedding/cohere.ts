/**
 * Ark KB — Cohere Embedding Provider
 */

import type { ResolvedProvider } from "../config.js";
import type { EmbedResult } from "./openai.js";

export async function cohereEmbed(
  provider: ResolvedProvider,
  texts: string[]
): Promise<EmbedResult> {
  const body: Record<string, any> = {
    model: provider.model.id,
    texts,
    input_type: "search_document",
    embedding_types: ["float"],
  };

  // Cohere uses output_dimension instead of dimensions
  if (provider.model.compat.supportsDimensions && provider.model.dimensions) {
    body.output_dimension = provider.model.dimensions;
  }

  const response = await fetch(provider.url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Cohere embedding error (${response.status}): ${err}`);
  }

  const data = (await response.json()) as any;
  const vectors = (data.embeddings?.float ?? data.embeddings ?? []) as number[][];

  return {
    vectors,
    dimensions: vectors[0]?.length ?? 0,
    model: provider.model.id,
  };
}
