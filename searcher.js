/**
 * Ark KB — Searcher
 * Hybrid BM25 + vector search with weighted fusion and optional reranking.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exposeMediaFile } from "./embedder.js";
const RERANKER_PRESETS = {
    siliconflow: {
        "BAAI/bge-reranker-v2-m3": {
            endpoint: "https://api.siliconflow.cn/v1/rerank",
            model: "BAAI/bge-reranker-v2-m3",
            minScore: 0.35,
        },
        "Qwen/Qwen3-Reranker-8B": {
            endpoint: "https://api.siliconflow.cn/v1/rerank",
            model: "Qwen/Qwen3-Reranker-8B",
            minScore: 0.1,
        },
        "Qwen/Qwen3-VL-Reranker-8B": {
            endpoint: "https://api.siliconflow.cn/v1/rerank",
            model: "Qwen/Qwen3-VL-Reranker-8B",
            minScore: 0.1,
        },
    },
    cohere: {
        "rerank-multilingual-v3.0": {
            endpoint: "https://api.cohere.ai/v1/rerank",
            model: "rerank-multilingual-v3.0",
            minScore: 0.35,
        },
    },
};
function resolveRerankerEndpoint(api, model, userEndpoint) {
    if (userEndpoint)
        return userEndpoint;
    return RERANKER_PRESETS[api]?.[model]?.endpoint ?? "";
}
function resolveRerankerModel(api, model, userModel) {
    const preset = RERANKER_PRESETS[api]?.[model];
    if (preset)
        return preset.model;
    return userModel ?? model;
}
function resolveRerankerMinScore(api, model, userMinScore) {
    if (userMinScore !== undefined)
        return userMinScore;
    return RERANKER_PRESETS[api]?.[model]?.minScore ?? 0.35;
}
// ============================================================================
// Searcher
// ============================================================================
export class Searcher {
    static IMG_EXTS = new Set(["png", "jpg", "jpeg", "jfif", "webp", "gif", "bmp", "svg", "tiff", "tif", "ico", "heic", "heif", "raw", "cr2", "nef", "arw"]);
    static VID_EXTS = new Set(["mp4", "mov", "avi", "mkv", "webm", "wmv", "flv", "m4v", "3gp", "ogv", "ts"]);
    store;
    embedder;
    knowledgePath;
    config;
    constructor(store, embedder, knowledgePath, config) {
        this.store = store;
        this.embedder = embedder;
        this.knowledgePath = knowledgePath;
        this.config = config;
    }
    /**
     * Perform hybrid search: vector ANN + BM25, weighted fusion, optional rerank.
     */
    async search(options) {
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
        const scoreMap = new Map();
        for (const r of normalizedVec) {
            const key = r.entry.id;
            const isMedia = Searcher.IMG_EXTS.has(r.entry.file_type) || Searcher.VID_EXTS.has(r.entry.file_type);
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
            if (Searcher.IMG_EXTS.has(r.entry.file_type) || Searcher.VID_EXTS.has(r.entry.file_type))
                continue;
            if (scoreMap.has(key)) {
                const existing = scoreMap.get(key);
                existing.fusedScore += bm25Weight * r.score;
                existing.bm25Score = r.score;
            }
            else {
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
        let finalResults;
        if (options.rerankerEnabled !== false && this.config.reranker?.enabled !== false && this.config.reranker?.api && this.config.reranker.api !== "none") {
            finalResults = await this.applyReranker(fusedResults.map(r => ({ entry: r.entry, score: r.fusedScore })), options.query, options.rerankerMinScore ?? this.config.reranker.minScore);
        }
        else {
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
    async getSource(sourcePath) {
        if (!this.knowledgePath)
            return null;
        const fullPath = join(this.knowledgePath, sourcePath);
        try {
            const full_text = await readFile(fullPath, "utf-8");
            return { source_path: sourcePath, full_text };
        }
        catch {
            return null;
        }
    }
    /**
     * Apply reranker API for precision re-ranking.
     */
    async applyReranker(results, query, minScore) {
        if (results.length === 0)
            return [];
        const rc = this.config.reranker;
        // Split: media results need a multimodal reranker, text results use cheap text reranker
        // BUT config.image/video.rerankerMode overrides: "text" mode sends media to text reranker
        const imageIsText = this.config.image?.rerankerMode === "text";
        const videoIsText = this.config.video?.rerankerMode === "text";
        const isMedia = (r) => {
            const ft = r.entry.file_type || "";
            const isImg = Searcher.IMG_EXTS.has(ft);
            const isVid = Searcher.VID_EXTS.has(ft);
            // Text-mode images/videos: treat as text (their chunk_text is VLM summary)
            if (isImg && imageIsText)
                return false;
            if (isVid && videoIsText)
                return false;
            return isImg || isVid;
        };
        const textResults = results.filter(r => !isMedia(r));
        const mediaResults = results.filter(r => isMedia(r));
        console.log(`[Ark KB] Reranker routing: ${textResults.length} text + ${mediaResults.length} media (img=${imageIsText ? "text" : "mm"}, vid=${videoIsText ? "text" : "mm"})`);
        let reranked = [];
        if (textResults.length > 0 && rc.apiKey) {
            const textMinScore = resolveRerankerMinScore(rc.api, rc.model, rc.minScore);
            console.log(`[Ark KB] Rerank text: ${textResults.length} results → model=${rc.model}`);
            reranked = await this.callReranker(textResults, query, textMinScore, rc.api, rc.model, rc.apiKey, rc.endpoint);
        }
        else {
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
        }
        else {
            // No multimodal reranker configured — keep vector scores for media
            console.log(`[Ark KB] Rerank mm: ${mediaResults.length} results → skipped (no mm reranker), keeping vector scores`);
            reranked.push(...mediaResults);
        }
        return reranked.sort((a, b) => b.score - a.score);
    }
    /** Call a single reranker API and return scored results. Falls back to input on error. */
    async callReranker(results, query, minScore, api, model, apiKey, userEndpoint) {
        if (results.length === 0)
            return [];
        const endpoint = resolveRerankerEndpoint(api, model, userEndpoint);
        const resolvedModel = resolveRerankerModel(api, model);
        try {
            // Build document list: text → chunk_text, image/video → HTTPS URL
            const documents = [];
            for (const r of results) {
                const ft = r.entry.file_type || "";
                if (Searcher.IMG_EXTS.has(ft) || Searcher.VID_EXTS.has(ft)) {
                    const url = await this.exposeMediaUrl(r.entry.source_path);
                    documents.push(url || r.entry.chunk_text);
                }
                else {
                    documents.push(r.entry.chunk_text);
                }
            }
            let response;
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
            const data = await response.json();
            if (data.results && Array.isArray(data.results)) {
                const scored = data.results
                    .filter((r) => r.relevance_score >= minScore)
                    .map((r) => ({ entry: results[r.index].entry, score: r.relevance_score }))
                    .sort((a, b) => b.score - a.score);
                // Reranker filtered everything → nothing relevant; don't fallback to vector-only noise
                return scored;
            }
            console.warn("[Ark KB] Unknown reranker response format, returning un-scored results");
            return results;
        }
        catch (err) {
            console.warn("[Ark KB] Reranker exception: " + err.message + ", falling back to fusion scores");
            return results;
        }
    }
    /** Expose a local media file for the reranker API. */
    async exposeMediaUrl(sourcePath) {
        return exposeMediaFile(this.knowledgePath, sourcePath);
    }
    detectRerankerApi(endpoint, apiKey) {
        if (!apiKey)
            return "none";
        const u = endpoint.toLowerCase();
        if (u.includes("siliconflow"))
            return "siliconflow";
        if (u.includes("cohere"))
            return "cohere";
        return "custom";
    }
}
// ============================================================================
// Score normalization (min-max to [0,1])
// ============================================================================
function normalizeScores(results) {
    if (results.length === 0)
        return [];
    const scores = results.map(r => r.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min;
    if (range === 0)
        return results.map(r => ({ ...r, score: 1 }));
    // Lower distance = better match → invert so 1.0 = best, 0.0 = worst
    return results.map(r => ({ ...r, score: 1 - (r.score - min) / range }));
}
//# sourceMappingURL=searcher.js.map