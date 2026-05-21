/**
 * Ark KB — Embedder
 * Multi-API embedder supporting DashScope, SiliconFlow, OpenAI, and custom endpoints.
 * Batch embedding with configurable batch size and exponential backoff retries.
 */

// ============================================================================
// Types
// ============================================================================

export interface EmbedderConfig {
  api: string;       // "dashscope" | "siliconflow" | "openai" | "custom"
  endpoint: string;
  apiKey: string;
  model: string;
  dimensions: number;
  batchSize: number;
}

export interface EmbedResult {
  embeddings: number[][];
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

// ============================================================================
// Embedder
// ============================================================================

export class Embedder {
  private config: EmbedderConfig;

  constructor(config: EmbedderConfig) {
    this.config = config;
  }

  /**
   * Embed a single text or a batch of texts.
   * Automatically splits into batchSize chunks and merges results.
   */
  async embed(texts: string | string[]): Promise<number[][]> {
    const inputs = Array.isArray(texts) ? texts : [texts];
    if (inputs.length === 0) return [];

    const allEmbeddings: number[][] = [];

    // Process in batches
    for (let i = 0; i < inputs.length; i += this.config.batchSize) {
      const batch = inputs.slice(i, i + this.config.batchSize);
      const batchResult = await this.embedBatchWithRetry(batch);
      allEmbeddings.push(...batchResult.embeddings);
    }

    return allEmbeddings;
  }

  private async embedBatchWithRetry(inputs: string[], attempt = 0): Promise<EmbedResult> {
    const maxAttempts = 3;
    try {
      return await this.embedBatch(inputs);
    } catch (err: any) {
      if (attempt < maxAttempts - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`[Ark KB] Embedding batch failed (attempt ${attempt + 1}), retrying in ${delay}ms: ${err.message}`);
        await sleep(delay);
        return this.embedBatchWithRetry(inputs, attempt + 1);
      }
      throw new Error(`[Ark KB] Embedding failed after ${maxAttempts} attempts: ${err.message}`);
    }
  }

  private async embedBatch(inputs: string[]): Promise<EmbedResult> {
    const { api, endpoint, apiKey, model, dimensions } = this.config;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    let body: any;

    switch (api) {
      case "dashscope":
        // DashScope uses x-knx-domain header for authentication
        headers["Authorization"] = `Bearer ${apiKey}`;
        headers["x-knx-domain"] = "search";
        body = {
          model,
          input: { documents: inputs.map(text => ({ text })) },
          parameters: { dimensions },
        };
        break;

      case "siliconflow":
      case "openai":
      case "custom":
        headers["Authorization"] = `Bearer ${apiKey}`;
        body = {
          model,
          input: inputs,
          dimensions,
        };
        break;

      default:
        throw new Error(`[Ark KB] Unknown embedding API: ${api}`);
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Embedding API error (${response.status}): ${errText}`);
    }

    const data = await response.json() as any;
    return this.parseResponse(data, api);
  }

  /**
   * Parse API-specific response format into standard embedding arrays.
   * All formats return OpenAI-compatible `data[index].embedding` arrays.
   */
  private parseResponse(data: any, api: string): EmbedResult {
    // OpenAI / SiliconFlow format
    if (data.data && Array.isArray(data.data)) {
      const embeddings = data.data
        .sort((a: any, b: any) => a.index - b.index)
        .map((item: any) => item.embedding as number[]);
      return {
        embeddings,
        model: data.model || this.config.model,
        usage: data.usage ? {
          prompt_tokens: data.usage.prompt_tokens || 0,
          total_tokens: data.usage.total_tokens || 0,
        } : undefined,
      };
    }

    // DashScope format: { output.embeddings: [{ embedding: number[], text_index: number }] }
    if (data.output?.embeddings && Array.isArray(data.output.embeddings)) {
      const embeddings = data.output.embeddings
        .sort((a: any, b: any) => a.text_index - b.text_index)
        .map((item: any) => item.embedding as number[]);
      return {
        embeddings,
        model: data.model || this.config.model,
        usage: data.usage,
      };
    }

    throw new Error(`[Ark KB] Unexpected embedding response format from ${api}: ${JSON.stringify(Object.keys(data))}`);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
