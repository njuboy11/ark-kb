/**
 * Ark KB — OpenAI-compatible Embedding Provider
 * Covers: OpenAI, SiliconFlow, DashScope, DeepSeek, Ollama, vLLM, etc.
 */

import type { ResolvedProvider } from "../config.js";

export interface EmbedResult {
  vectors: number[][];
  dimensions: number;
  model: string;
}

export async function openaiEmbed(
  provider: ResolvedProvider,
  texts: string[]
): Promise<EmbedResult> {
  const body: Record<string, any> = {
    model: provider.model.id,
    input: texts,
  };

  // Only send dimensions if the model supports it and user specified one
  if (provider.model.compat.supportsDimensions && provider.model.dimensions) {
    body.dimensions = provider.model.dimensions;
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
    throw new Error(`OpenAI embedding error (${response.status}): ${err}`);
  }

  const data = (await response.json()) as any;
  const vectors = data.data?.map((d: any) => d.embedding as number[]) ?? [];

  return {
    vectors,
    dimensions: vectors[0]?.length ?? 0,
    model: provider.model.id,
  };
}
