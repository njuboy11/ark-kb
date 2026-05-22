/**
 * Ark KB — Searcher
 * Hybrid BM25 + vector search with weighted fusion and optional reranking.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { KnowledgeStore, KBSearchResult, KBEntry } from "./store.js";
import { Embedder } from "./embedder.js";
import { SearcherConfig } from "./index.js";

// ============================================================================
// Types
// ============================================================================

export interface SearchOptions {
  query: string;
  topK?: number;
  rerankerEnabled?: boolean;
  rerankerMinScore?: number;
  resultCount?: number;
}

export interface SearchResult {
  score: number;
  chunk_text: string;
  source_path: string;
  chunk_index: number;
  total_chunks: number;
  images: string[];
  file_type: string;
  relevance_score?: number;
}

export interface SourceContent {
  source_path: string;
  full_text: string;
}

// ============================================================================
// Reranker API configs
// ============================================================================

interface RerankerConfig {
  api: string;
  endpoint: string;
  apiKey: string;
  model: string;
}

// ============================================================================
// Reranker model registry — hardcoded vendor/model defaults
// ============================================================================

interface RerankerPreset {
  endpoint: string;
  model: string;
}

const RERANKER_PRESETS: Record<string, Record<string, RerankerPreset>> = {
  siliconflow: {
    "BAAI/bge-reranker-v2-m3": {
      endpoint: "https://api.siliconflow.cn/v1/rerank",
      model: "BAAI/bge-reranker-v2-m3",
    },
    "Qwen/Qwen3-Reranker-8B": {
      endpoint: "https://api.siliconflow.cn/v1/rerank",
      model: "Qwen/Qwen3-Reranker-8B",
    },
    "Qwen/Qwen3-VL-Reranker-8B": {
      endpoint: "https://api.siliconflow.cn/v1/rerank",
      model: "Qwen/Qwen3-VL-Reranker-8B",
    },
  },
  cohere: {
    "rerank-multilingual-v3.0": {
      endpoint: "https://api.cohere.ai/v1/rerank",
      model: "rerank-multilingual-v3.0",
    },
  },
};

function resolveRerankerEndpoint(api: string, model: string, userEndpoint?: string): string {
  if (userEndpoint) return userEndpoint;
  return RERANKER_PRESETS[api]?.[model]?.endpoint ?? "";
}

function resolveRerankerModel(api: string, model: string, userModel?: string): string {
  const preset = RERANKER_PRESETS[api]?.[model];
  if (preset) return preset.model;
  return userModel ?? model;
}

// ============================================================================
// Searcher
// ============================================================================

export class Searcher {
  private store: KnowledgeStore;
  private embedder: Embedder;
  private knowledgePath: string;
  private config: SearcherConfig;

  constructor(
    store: KnowledgeStore,
    embedder: Embedder,
    knowledgePath: string,
    config: SearcherConfig,
  ) {
    this.store = store;
    this.embedder = embedder;
    this.knowledgePath = knowledgePath;
    this.config = config;
  }

  /**
   * Perform hybrid search: vector ANN + BM25, weighted fusion, optional rerank.
   */
  async search(options: SearchOptions): Promise<SearchResult[]> {
    const topK = options.topK ?? this.config.search.topK;
    const vectorWeight = this.config.search.vectorWeight;
    const bm25Weight = 1 - vectorWeight;
    const resultCount = options.resultCount ?? this.config.search.resultCount;

    // 1. Embed the query
    const [queryVector] = await this.embedder.embed(options.query);

    // 2. Run vector ANN search and BM25 search in parallel
    const [vecResults, bm25Results] = await Promise.all([
      this.store.search(queryVector, topK),
      this.store.searchBM25(options.query, topK),
    ]);

    // 3. Normalize scores for each arm (min-max to [0,1])
    const normalizedVec = normalizeScores(vecResults);
    const normalizedBm25 = normalizeScores(bm25Results);

    // 4. Build a unified result map with weighted fusion
    const scoreMap = new Map<string, { entry: KBEntry; fusedScore: number; vecScore: number; bm25Score: number }>();

    for (const r of normalizedVec) {
      const key = r.entry.id;
      scoreMap.set(key, {
        entry: r.entry,
        fusedScore: vectorWeight * r.score,
        vecScore: r.score,
        bm25Score: 0,
      });
    }

    for (const r of normalizedBm25) {
      const key = r.entry.id;
      if (scoreMap.has(key)) {
        const existing = scoreMap.get(key)!;
        existing.fusedScore += bm25Weight * r.score;
        existing.bm25Score = r.score;
      } else {
        scoreMap.set(key, {
          entry: r.entry,
          fusedScore: bm25Weight * r.score,
          vecScore: 0,
          bm25Score: r.score,
        });
      }
    }

    // 5. Sort by fused score
    const fusedResults = Array.from(scoreMap.values())
      .sort((a, b) => b.fusedScore - a.fusedScore)
      .slice(0, topK);

    // 6. Optional reranking
    let finalResults: KBSearchResult[];
    if (options.rerankerEnabled !== false && this.config.reranker?.enabled !== false && this.config.reranker?.api && this.config.reranker.api !== "none") {
      finalResults = await this.applyReranker(
        fusedResults.map(r => ({ entry: r.entry, score: r.fusedScore })),
        options.query,
        options.rerankerMinScore ?? this.config.reranker.minScore,
      );
    } else {
      finalResults = fusedResults.map(r => ({ entry: r.entry, score: r.fusedScore }));
    }

    // 7. Format and return
    return finalResults.slice(0, resultCount).map(r => ({
      score: r.score,
      chunk_text: r.entry.chunk_text.substring(0, 500),
      source_path: r.entry.source_path,
      chunk_index: r.entry.chunk_index,
      total_chunks: r.entry.total_chunks,
      images: JSON.parse(r.entry.images || "[]"),
      file_type: r.entry.file_type,
    }));
  }

  /**
   * Read the full source file from the knowledge path.
   */
  async getSource(sourcePath: string): Promise<SourceContent | null> {
    if (!this.knowledgePath) return null;
    const fullPath = join(this.knowledgePath, sourcePath);
    try {
      const full_text = await readFile(fullPath, "utf-8");
      return { source_path: sourcePath, full_text };
    } catch {
      return null;
    }
  }

  /**
   * Apply reranker API for precision re-ranking.
   */
  private async applyReranker(
    results: KBSearchResult[],
    query: string,
    minScore: number,
  ): Promise<KBSearchResult[]> {
    if (results.length === 0) return [];

    const rc = this.config.reranker!;

    // Split: media results need a multimodal reranker, text results use cheap text reranker
    const textResults = results.filter(r => r.entry.file_type !== "image" && r.entry.file_type !== "video");
    const mediaResults = results.filter(r => r.entry.file_type === "image" || r.entry.file_type === "video");

    // Rerank text results with text model
    let reranked: KBSearchResult[] = [];
    if (textResults.length > 0 && rc.apiKey) {
      reranked = await this.callReranker(textResults, query, minScore, rc.api, rc.model, rc.apiKey, rc.endpoint);
    } else {
      reranked = textResults;
    }

    // Rerank media results with multimodal model (if configured)
    const mmCfg = rc.multimodal;
    if (mediaResults.length > 0 && mmCfg?.apiKey) {
      const mmApi = this.detectRerankerApi(mmCfg.endpoint ?? rc.endpoint, mmCfg.apiKey);
      const mmReranked = await this.callReranker(mediaResults, query, minScore, mmApi, mmCfg.model ?? "", mmCfg.apiKey, mmCfg.endpoint ?? rc.endpoint);
      reranked.push(...mmReranked);
    } else {
      // No multimodal reranker configured — keep vector scores for media
      reranked.push(...mediaResults);
    }

    return reranked.sort((a, b) => b.score - a.score);
  }

  /** Call a single reranker API and return scored results. Falls back to input on error. */
  private async callReranker(
    results: KBSearchResult[],
    query: string,
    minScore: number,
    api: string,
    model: string,
    apiKey: string,
    userEndpoint: string,
  ): Promise<KBSearchResult[]> {
    if (results.length === 0) return [];

    const endpoint = resolveRerankerEndpoint(api, model, userEndpoint);
    const resolvedModel = resolveRerankerModel(api, model);

    try {
      const documents = results.map(r => r.entry.chunk_text);

      let response: Response;

      switch (api) {
        case "siliconflow":
          response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "*** " + apiKey },
            body: JSON.stringify({ model: resolvedModel, query, documents, return_documents: false }),
          });
          break;
        case "cohere":
          response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "*** " + apiKey },
            body: JSON.stringify({ model: resolvedModel, query, documents, top_n: documents.length, return_documents: false }),
          });
          break;
        case "custom":
          response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "*** " + apiKey },
            body: JSON.stringify({ model: resolvedModel, query, documents }),
          });
          break;
        default:
          return results;
      }

      if (!response.ok) {
        const err = await response.text();
        console.warn("[Ark KB] Reranker API error (" + response.status + "): " + err);
        return results;
      }

      const data = await response.json() as any;

      if (data.results && Array.isArray(data.results)) {
        const scored = data.results
          .filter((r: any) => r.relevance_score >= minScore)
          .map((r: any) => ({ entry: results[r.index].entry, score: r.relevance_score }))
          .sort((a: any, b: any) => b.score - a.score);
        return scored.length > 0 ? scored : results;
      }

      console.warn("[Ark KB] Unknown reranker response format, returning un-scored results");
      return results;
    } catch (err: any) {
      console.warn("[Ark KB] Reranker exception: " + err.message + ", falling back to fusion scores");
      return results;
    }
  }

  private detectRerankerApi(endpoint: string, apiKey: string): "siliconflow" | "cohere" | "custom" | "none" {
    if (!apiKey) return "none";
    const u = endpoint.toLowerCase();
    if (u.includes("siliconflow")) return "siliconflow";
    if (u.includes("cohere")) return "cohere";
    return "custom";
  }

}

// ============================================================================
// Score normalization (min-max to [0,1])
// ============================================================================

function normalizeScores(results: KBSearchResult[]): KBSearchResult[] {
  if (results.length === 0) return [];
  const scores = results.map(r => r.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;
  if (range === 0) return results.map(r => ({ ...r, score: 1 }));
  return results.map(r => ({ ...r, score: (r.score - min) / range }));
}
