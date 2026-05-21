/**
 * Ark KB — Searcher
 * 语义搜索 + 可选的 Reranker 精排
 */

import { KnowledgeStore, KBSearchResult, KBEntry } from "./store.js";
import { Embedder } from "./embedder.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface SearchOptions {
  query: string;
  topK: number;
  rerankerEnabled: boolean;
  rerankerMinScore: number;
  resultCount: number;
}

export interface SearchResult {
  score: number;
  chunk_text: string;
  source_path: string;
  chunk_index: number;
  total_chunks: number;
  images: string[];
  file_type: string;
}

export interface SourceContent {
  source_path: string;
  full_text: string;
}

// ============================================================================
// Searcher
// ============================================================================

export class Searcher {
  private store: KnowledgeStore;
  private embedder: Embedder;
  private knowledgePath: string;

  constructor(
    store: KnowledgeStore,
    embedder: Embedder,
    knowledgePath: string,
  ) {
    this.store = store;
    this.embedder = embedder;
    this.knowledgePath = knowledgePath;
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    // 1. 将 query 转成向量
    const [queryVector] = await this.embedder.embed(options.query);

    // 2. LanceDB 近似近邻搜索
    const rawResults = await this.store.search(queryVector, options.topK);

    // 3. 可选：Reranker 精排
    let results: KBSearchResult[];
    if (options.rerankerEnabled) {
      results = await this.applyReranker(rawResults, options.query, options.rerankerMinScore);
    } else {
      results = rawResults;
    }

    // 4. 取 top N
    return results.slice(0, options.resultCount).map((r) => ({
      score: r.score,
      chunk_text: r.entry.chunk_text.substring(0, 500), // 预览
      source_path: r.entry.source_path,
      chunk_index: r.entry.chunk_index,
      total_chunks: r.entry.total_chunks,
      images: JSON.parse(r.entry.images || "[]"),
      file_type: r.entry.file_type,
    }));
  }

  /**
   * 获取搜索结果的完整原文
   */
  async getSource(sourcePath: string): Promise<SourceContent | null> {
    const fullPath = join(this.knowledgePath, sourcePath);
    try {
      const full_text = await readFile(fullPath, "utf-8");
      return { source_path: sourcePath, full_text };
    } catch {
      return null;
    }
  }

  /**
   * Reranker 精排（BGE-m3 或其他 cross-encoder）
   */
  private async applyReranker(
    results: KBSearchResult[],
    query: string,
    minScore: number,
  ): Promise<KBSearchResult[]> {
    if (results.length === 0) return [];

    // Reranker API 调用
    const pairs = results.map((r) => ({
      query,
      passage: r.entry.chunk_text,
    }));

    try {
      const response = await fetch("https://api.siliconflow.cn/v1/rerank", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${getRerankerKey()}`,
        },
        body: JSON.stringify({
          model: "BAAI/bge-m3",
          query,
          documents: results.map((r) => r.entry.chunk_text),
          return_documents: false,
        }),
      });

      if (!response.ok) {
        console.warn("[Ark KB] Reranker 调用失败，回退到原始排序");
        return results;
      }

      const data = (await response.json()) as any;

      if (data.results && Array.isArray(data.results)) {
        const scored = data.results.map((r: any) => ({
          entry: results[r.index].entry,
          score: r.relevance_score,
        }));
        return scored
          .filter((r: any) => r.score >= minScore)
          .sort((a: any, b: any) => b.score - a.score);
      }
    } catch (err) {
      console.warn("[Ark KB] Reranker 异常，回退到原始排序:", err);
    }

    return results;
  }
}

function getRerankerKey(): string {
  // 从环境变量读取（由 OpenClaw 配置注入）
  return process.env.ARK_KB_RERANKER_KEY || "";
}
