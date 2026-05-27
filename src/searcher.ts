/**
 * Ark KB — Searcher
 * Hybrid BM25 + vector search with weighted fusion and optional reranking.
 */

import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync, chmodSync } from "node:fs";
import { KnowledgeStore, KBSearchResult, KBEntry } from "./store.js";
import { Embedder, exposeMediaFile } from "./embedder.js";
import { SearcherConfig } from "./index.js";
import { rerank } from "./providers/reranker/index.js";
import { detectProtocol } from "./providers/detector.js";

/** Safely parse images field (already array or JSON string). */
function safeParseImages(val: unknown): string[] {
  if (Array.isArray(val)) return val as string[];
  if (typeof val !== "string" || !val) return [];
  try { return JSON.parse(val) as string[]; } catch { return []; }
}

// ============================================================================
// Types
// ============================================================================

export interface SearchOptions {
  query: string;
  topK?: number;
  rerankerEnabled?: boolean;
  rerankerMinScore?: number;
  resultCount?: number;
  fileType?: string;
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

// ---- Fallback endpoints (no model-specific presets) ----


function resolveRerankerEndpoint(api: string, _model: string, userEndpoint?: string): string {
  return userEndpoint || "";
}

function resolveRerankerMinScore(api: string, _model: string, userMinScore?: number): number {
  return userMinScore ?? 0.35;
}

// ============================================================================
// Searcher
// ============================================================================

export class Searcher {
  private static IMG_EXTS = new Set(["png","jpg","jpeg","jfif","webp","gif","bmp","svg","tiff","tif","ico","heic","heif","raw","cr2","nef","arw"]);
  private static VID_EXTS = new Set(["mp4","mov","avi","mkv","webm","wmv","flv","m4v","3gp","ogv","ts"]);

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
      this.store.search(queryVector, topK, options.fileType),
      this.store.searchBM25(options.query, topK),
    ]);

    // 3. Normalize scores for each arm (min-max to [0,1])
    const normalizedVec = normalizeScores(vecResults);
    const normalizedBm25 = normalizeScores(bm25Results, true);

    // 4. Build a unified result map with weighted fusion
    const scoreMap = new Map<string, { entry: KBEntry; fusedScore: number; vecScore: number; bm25Score: number }>();

    for (const r of normalizedVec) {
      const key = r.entry.id;
      // Text-mode images/videos have real text in chunk_text → treat as text
      const ft = r.entry.file_type;
      const isImg = Searcher.IMG_EXTS.has(ft);
      const isVid = Searcher.VID_EXTS.has(ft);
      const imageIsText = this.config.method.image === "text";
      const videoIsText = this.config.method.video === "text";
      const isMedia = (isImg && !imageIsText) || (isVid && !videoIsText);
      // Image/video get 100% vector weight — BM25 has nothing meaningful to contribute
      const w = isMedia ? 1.0 : vectorWeight;
      scoreMap.set(key, {
        entry: r.entry,
        fusedScore: w * r.score,
        vecScore: r.score,
        bm25Score: 0,
      });
    }

    for (const r of normalizedBm25) {
      const key = r.entry.id;
      // Skip BM25 for image/video — they only have placeholder text, not real content
      if (Searcher.IMG_EXTS.has(r.entry.file_type) || Searcher.VID_EXTS.has(r.entry.file_type)) continue;
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
      images: safeParseImages(r.entry.images),
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

    // Provider-based reranking (new multi-provider system)
    const rp = this.config.providers?.reranker;
    if (rp) {
      try {
        const documents = results.map(r => r.entry.chunk_text);
        const scored = await rerank(rp, query, documents);
        return scored
          .filter(r => r.score >= minScore)
          .map(r => ({ ...results[r.index], score: r.score }))
          .sort((a, b) => b.score - a.score);
      } catch (err: any) {
        console.warn("[Ark KB] Provider reranker failed: " + err.message + ", falling back to legacy");
        // Fall through to legacy reranker
      }
    }

    // Legacy reranker (hardcoded SiliconFlow / Cohere / custom)
    const rc = this.config.reranker!;

    // Split: media results need a multimodal reranker, text results use cheap text reranker
    // BUT config.method overrides: "text" mode sends media to text reranker (VLM summary in chunk_text)
    const imageIsText = this.config.method.image === "text";
    const videoIsText = this.config.method.video === "text";
    const isMedia = (r: KBSearchResult) => {
      const ft = r.entry.file_type || "";
      const isImg = Searcher.IMG_EXTS.has(ft);
      const isVid = Searcher.VID_EXTS.has(ft);
      // Text-mode images/videos: treat as text (their chunk_text is VLM summary)
      if (isImg && imageIsText) return false;
      if (isVid && videoIsText) return false;
      return isImg || isVid;
    };
    const textResults = results.filter(r => !isMedia(r));
    const mediaResults = results.filter(r => isMedia(r));

    console.log(`[Ark KB] Reranker routing: ${textResults.length} text + ${mediaResults.length} media (img=${imageIsText ? "text" : "mm"}, vid=${videoIsText ? "text" : "mm"})`);
    let reranked: KBSearchResult[] = [];
    if (textResults.length > 0 && rc.apiKey) {
      const textMinScore = resolveRerankerMinScore(rc.api, rc.model, rc.minScore);
      console.log(`[Ark KB] Rerank text: ${textResults.length} results → model=${rc.model}`);
      reranked = await this.callReranker(textResults, query, textMinScore, rc.api, rc.model, rc.apiKey, rc.endpoint);
    } else {
      reranked = textResults;
    }

    // Rerank media results with multimodal model (if configured)
    const mmCfg = rc.multimodal;
    if (mediaResults.length > 0 && mmCfg?.apiKey) {
      const mmApi = this.detectRerankerApi(mmCfg.endpoint ?? rc.endpoint, mmCfg.apiKey);
      const mmMinScore = resolveRerankerMinScore(mmApi, mmCfg.model ?? "", mmCfg.model ? undefined : rc.minScore);
      console.log(`[Ark KB] Rerank mm: ${mediaResults.length} results → model=${mmCfg.model}`);
      const mmReranked = await this.callReranker(mediaResults, query, mmMinScore, mmApi, mmCfg.model ?? "", mmCfg.apiKey, mmCfg.endpoint ?? rc.endpoint);
      reranked.push(...mmReranked);
    } else {
      // No multimodal reranker configured — keep vector scores for media
      console.log(`[Ark KB] Rerank mm: ${mediaResults.length} results → skipped (no mm reranker), keeping vector scores`);
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
    const resolvedModel = model;

    try {
      // Build document list: text → chunk_text, image/video → HTTPS URL
      const documents: string[] = [];
      for (const r of results) {
        const ft = r.entry.file_type || "";
        if (Searcher.IMG_EXTS.has(ft) || Searcher.VID_EXTS.has(ft)) {
          const url = await this.exposeMediaUrl(r.entry.source_path);
          documents.push(url || r.entry.chunk_text);
        } else {
          documents.push(r.entry.chunk_text);
        }
      }

      let response: Response;

      switch (api) {
        case "siliconflow":
          response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
            body: JSON.stringify({ model: resolvedModel, query, documents, return_documents: false }),
          });
          break;
        case "cohere":
          response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
            body: JSON.stringify({ model: resolvedModel, query, documents, top_n: documents.length, return_documents: false }),
          });
          break;
        case "custom":
          response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
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
        // Reranker filtered everything → nothing relevant; don't fallback to vector-only noise
        return scored;
      }

      console.warn("[Ark KB] Unknown reranker response format, returning un-scored results");
      return results;
    } catch (err: any) {
      console.warn("[Ark KB] Reranker exception: " + err.message + ", falling back to fusion scores");
      return results;
    }
  }

  /** Expose a local media file for the reranker API. */
  private async exposeMediaUrl(sourcePath: string): Promise<string> {
    return exposeMediaFile(this.knowledgePath, sourcePath);
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

function normalizeScores(results: KBSearchResult[], higherIsBetter = false): KBSearchResult[] {
  if (results.length === 0) return [];
  const scores = results.map(r => r.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;
  if (range === 0) return results.map(r => ({ ...r, score: 1 }));
  // Lower distance = better match → invert so 1.0 = best, 0.0 = worst
  return results.map(r => ({ ...r, score: higherIsBetter ? (r.score - min) / range : 1 - (r.score - min) / range }));
}
