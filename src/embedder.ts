/**
 * Ark KB — Embedder 层
 * 封装多模态 Embedding API 调用（Qwen3-VL-Embedding-8B）
 */

// ============================================================================
// Types
// ============================================================================

export interface EmbedderConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
}

// ============================================================================
// Embedder
// ============================================================================

export class Embedder {
  private config: EmbedderConfig;

  constructor(config: EmbedderConfig) {
    this.config = config;
  }

  async embed(text: string | string[]): Promise<number[][]> {
    const inputs = Array.isArray(text) ? text : [text];

    const response = await fetch(this.config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        input: inputs,
        dimensions: this.config.dimensions,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Embedding API error (${response.status}): ${err}`);
    }

    const data = await response.json() as any;

    // 兼容 OpenAI 格式返回
    if (data.data && Array.isArray(data.data)) {
      return data.data
        .sort((a: any, b: any) => a.index - b.index)
        .map((item: any) => item.embedding);
    }

    throw new Error(`Unexpected embedding response format`);
  }
}
