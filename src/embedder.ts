/**
 * Ark KB — Embedder
 * Multi-API embedder supporting DashScope, SiliconFlow, OpenAI, and custom endpoints.
 * Batch embedding with configurable batch size and exponential backoff retries.
 */

// ============================================================================
// Types
// ============================================================================

import { copyFile, readFile, unlink } from "node:fs/promises";
import { existsSync, chmodSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { embed as providerEmbed } from "./providers/embedding/index.js";

export interface EmbedderConfig {
  api: string;       // "dashscope" | "siliconflow" | "openai" | "custom"
  endpoint: string;
  apiKey: string;
  model: string;
  dimensions: number;
  batchSize: number;
  providers?: import("./providers/config.js").ResolvedProvider;
}

export interface EmbedResult {
  embeddings: number[][];
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

// ============================================================================
// Model capabilities registry
// ============================================================================

/** Supported input modalities per embedding model */
const MODEL_CAPABILITIES: Record<string, string[]> = {
  "text-embedding-v4": ["text"],
  "text-embedding-v3": ["text"],
  "text-embedding-v2": ["text"],
  "Qwen/Qwen3-VL-Embedding-8B": ["text", "image"],
  "Qwen/Qwen3-Embedding-8B": ["text"],
  "text-embedding-3-large": ["text"],
  "text-embedding-3-small": ["text"],
  "text-embedding-ada-002": ["text"],
};

/** Get the modalities supported by an embedding model. Defaults to ["text"]. */
export function getModelCapabilities(model: string): string[] {
  return MODEL_CAPABILITIES[model] ?? ["text"];
}

/** Reranker model capabilities */
const RERANKER_MODEL_CAPABILITIES: Record<string, string[]> = {
  "Qwen/Qwen3-Reranker-8B": ["text"],
  "BAAI/bge-reranker-v2-m3": ["text"],
  "Qwen/Qwen3-VL-Reranker-8B": ["text", "image"],
};

/** Get the modalities supported by a reranker model. Defaults to ["text"]. */
export function getRerankerCapabilities(_model: string): string[] {
  return ["text"];
}

export function resolveRerankerCapabilities(_api: string, _model: string): string[] {
  return ["text"];
}

export function resolveEmbeddingEndpoint(api: string, _model: string, userEndpoint?: string): string {
  return userEndpoint || "";
}

export function resolveEmbeddingBatchSize(_api: string, _model: string): number {
  return 16;
}

export function resolveEmbeddingDimensions(_api: string, _model: string, userDim?: number): number {
  return userDim ?? 4096;
}

export function resolveEmbeddingModalities(_api: string, _model: string): string[] {
  return ["text"];
}

export async function exposeMediaFile(
  knowledgePath: string,
  sourcePath: string,
): Promise<string> {
  const serveDir = "/var/www/downloads";
  const baseName = basename(sourcePath);

  const safePath = resolve(knowledgePath, sourcePath);
  if (!safePath.startsWith(resolve(knowledgePath))) {
    return "";
  }

  if (existsSync(serveDir)) {
    try {
      const dest = join(serveDir, baseName);
      await copyFile(safePath, dest);
      chmodSync(dest, 0o644);
      return `https://home.sfunds.cn:8444/${encodeURIComponent(baseName)}`;
    } catch {}
  }

  try {
    const fileBuffer = await readFile(safePath);
    return fileBuffer.toString("base64");
  } catch {
    return "";
  }
}

export async function cleanupExposedMedia(sourcePath: string): Promise<void> {
  const serveDir = "/var/www/downloads";
  if (!existsSync(serveDir)) return;
  const dest = join(serveDir, basename(sourcePath));
  try { await unlink(dest); } catch {}
}

export class Embedder {
  private config: EmbedderConfig;

  constructor(config: EmbedderConfig) {
    this.config = config;
  }

  /** Check if this model supports a given input modality */
  supportsModality(kind: string): boolean {
    return resolveEmbeddingModalities(this.config.api, this.config.model).includes(kind);
  }

  async embed(texts: string | string[]): Promise<number[][]> {
    const inputs = (Array.isArray(texts) ? texts : [texts]).filter(s => s.trim().length > 0);
    if (inputs.length === 0) return [];

    const batchSize = this.config.batchSize;
    const allEmbeddings: number[][] = [];
    for (let i = 0; i < inputs.length; i += batchSize) {
      const batch = inputs.slice(i, i + batchSize);
      const result = await this.embedBatchWithRetry(batch);
      for (const emb of result.embeddings) allEmbeddings.push(emb);
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
    // Provider-based embedding (new system)
    if (this.config.providers) {
      try {
        const result = await providerEmbed(this.config.providers, inputs);
        return {
          embeddings: result.vectors,
          model: result.model,
        };
      } catch (err: any) {
        console.warn("[Ark KB] Provider embed failed: " + err.message + ", falling back to legacy");
      }
    }

    // Legacy embedding (hardcoded APIs)
    const { api, endpoint, apiKey, model, dimensions } = this.config;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let body: any;

    switch (api) {
      case "dashscope":
        if (endpoint.includes("compatible-mode")) {
          headers["Authorization"] = `Bearer ${apiKey}`;
          body = { model, input: inputs, dimensions };
        } else {
          headers["Authorization"] = `Bearer ${apiKey}`;
          headers["x-knx-domain"] = "search";
          body = { model, input: { documents: inputs.map(text => ({ text })) }, parameters: { dimensions } };
        }
        break;

      case "siliconflow":
      case "openai":
      case "custom":
        headers["Authorization"] = `Bearer ${apiKey}`;
        body = { model, input: inputs, dimensions };
        break;

      default:
        throw new Error(`[Ark KB] Unknown embedding API: ${api}`);
    }

    const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Embedding API error (${response.status}): ${errText}`);
    }

    const data = await response.json() as any;
    return this.parseResponse(data, api);
  }

  private parseResponse(data: any, api: string): EmbedResult {
    if (data.data && Array.isArray(data.data)) {
      const embeddings = data.data.sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0)).map((item: any) => item.embedding as number[]);
      return { embeddings, model: data.model || this.config.model, usage: data.usage ? { prompt_tokens: data.usage.prompt_tokens || 0, total_tokens: data.usage.total_tokens || 0 } : undefined };
    }
    if (data.output?.embeddings && Array.isArray(data.output.embeddings)) {
      const embeddings = data.output.embeddings.sort((a: any, b: any) => (a.text_index ?? 0) - (b.text_index ?? 0)).map((item: any) => item.embedding as number[]);
      return { embeddings, model: data.model || this.config.model, usage: data.usage };
    }
    throw new Error(`[Ark KB] Unexpected embedding response format from ${api}: ${JSON.stringify(Object.keys(data))}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
