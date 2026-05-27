/**
 * Ark KB — VLM Providers (OpenAI / Anthropic / MiniMax)
 */

import type { ResolvedProvider } from "../config.js";

export interface VLMResult {
  text: string;
  tokensUsed?: number;
}

// ---- OpenAI-compatible VLM ----
export async function openaiVLM(
  provider: ResolvedProvider,
  imageBase64: string,
  prompt: string,
  mimeType: string = "image/png"
): Promise<VLMResult> {
  const response = await fetch(provider.url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model.id,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${imageBase64}` },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI VLM error (${response.status}): ${err}`);
  }

  const data = (await response.json()) as any;
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    tokensUsed: data.usage?.total_tokens,
  };
}

// ---- Anthropic-compatible VLM ----
export async function anthropicVLM(
  provider: ResolvedProvider,
  imageBase64: string,
  prompt: string,
  mimeType: string = "image/png"
): Promise<VLMResult> {
  const response = await fetch(provider.url, {
    method: "POST",
    headers: {
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model.id,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType,
                data: imageBase64,
              },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic VLM error (${response.status}): ${err}`);
  }

  const data = (await response.json()) as any;
  return {
    text: data.content?.[0]?.text ?? "",
    tokensUsed: data.usage?.input_tokens + (data.usage?.output_tokens ?? 0),
  };
}

// ---- MiniMax VLM (proprietary) ----
export async function minimaxVLM(
  provider: ResolvedProvider,
  imageBase64: string,
  prompt: string,
  mimeType: string = "image/png"
): Promise<VLMResult> {
  const response = await fetch(provider.url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model.id,
      messages: [
        {
          role: "user",
          content: `data:${mimeType};base64,${imageBase64}\n\n${prompt}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`MiniMax VLM error (${response.status}): ${err}`);
  }

  const data = (await response.json()) as any;
  return {
    text: data.choices?.[0]?.message?.content ?? data.reply ?? "",
  };
}
