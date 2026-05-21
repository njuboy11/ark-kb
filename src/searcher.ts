/**
 * Ark KB — Searcher
 * Hybrid BM25 + vector search with optional reranking.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { KnowledgeStore, KBEntry, KBSearchResult } from "./store.js";
import { Embedder } from "./embedder.js";
import type { ResolvedConfig } from "./config.js";

// ============================================================================
// Types
// ============================================================================

export interface SearchOptions {
  query: string;
  topK?: number;
  resultCount?: number;
  vectorWeight?: number;
  bm25Enabled?: boolean;
  rerankerEnabled?: boolean;
  rerankerMinScore?: number;
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
  private config: ResolvedConfig;

  constructor(store: KnowledgeStore, embedder: Embedder, config: ResolvedConfig) {
    this.store = store;
    this.embedder = embedder;
    this.config = config;
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const topK = options.topK ?? this.config.search.topK;
    const resultCount = options.resultCount ?? this.config.search.resultCount;
    const vectorWeight = options.vectorWeight ?? this.config.search.vectorWeight;
    const bm25Enabled = options.bm25Enabled ?? this.config.search.bm25Enabled;

    // 1. Embed the query
    const [queryVector] = await this.embedder.embed(options.query);

    // 2. Run vector search and BM25 in parallel
    const [vectorResults, bm25Results] = await Promise.all([
      this.store.vectorSearch(queryVector, topK),
      bm25Enabled ? this.store.bm25Search(options.query, topK) : Promise.resolve([]),
    ]);

    // 3. Fuse results
    let fused: KBSearchResult[];
    const fusionMethod = this.config.search.fusionMethod;
    if (bm25Enabled && bm25Results.length > 0) {
      fused = this.store.fuseResults(vectorResults, bm25Results, vectorWeight, fusionMethod);
    } else {
      fused = vectorResults;
    }

    // 4. Optional reranker
    let results: KBSearchResult[];
    if (options.rerankerEnabled && fused.length > 0) {
      results = await this.applyReranker(fused, options.query);
      // Filter by min score
      const minScore = options.rerankerMinScore ?? this.config.reranker.minScore;
      results = results.filter((r) => r.score >= minScore);
    } else {
      results = fused;
    }

    // 5. Return top N
    return results.slice(0, resultCount).map((r) => ({
      score: r.score,
      chunk_text: r.entry.chunk_text.slice(0, 500),
      source_path: r.entry.source_path,
      chunk_index: r.entry.chunk_index,
      total_chunks: r.entry.total_chunks,
      images: JSON.parse(r.entry.images || "[]"),
      file_type: r.entry.file_type,
    }));
  }

  /**
   * Read the full content of a source file.
   */
  async getSource(sourcePath: string): Promise<SourceContent | null> {
    const fullPath = join(this.config.knowledgePath, sourcePath);
    try {
      const full_text = await readFile(fullPath, "utf-8");
      return { source_path: sourcePath, full_text };
    } catch {
      return null;
    }
  }

  // ========================================================================
  // Reranker
  // ========================================================================

  private async applyReranker(
    results: KBSearchResult[],
    query: string,
  ): Promise<KBSearchResult[]> {
    if (results.length === 0) return [];

    const rerankerApi = this.config.reranker.api;
    if (rerankerApi === "none") {
      return results;
    }

    const endpoint = this.config.reranker.endpoint;
    const apiKey = this.config.reranker.apiKey;
    const model = this.config.reranker.model;

    if (!apiKey) {
      console.warn("[Ark KB] Reranker API key not configured, skipping reranker");
      return results;
    }

    try {
      const documents = results.map((r) => r.entry.chunk_text);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          query,
          documents,
          return_documents: false,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        console.warn(`[Ark KB] Reranker API error (${response.status}): ${err}`);
        return results;
      }

      const data = await response.json() as any;

      if (Array.isArray(data.results)) {
        return data.results
          .map((r: any) => ({
            entry: results[r.index].entry,
            score: r.relevance_score ?? r.score ?? 0,
          }))
          .sort((a: any, b: any) => b.score - a.score);
      }

    } catch (err) {
      console.warn("[Ark KB] Reranker exception:", err);
    }

    return results;
  }
}
