/**
 * Ark KB — Searcher
 * Hybrid BM25 + vector search with weighted fusion and optional reranking.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
// ============================================================================
// Searcher
// ============================================================================
export class Searcher {
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
        if (options.rerankerEnabled && this.config.reranker?.api && this.config.reranker.api !== "none") {
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
        const rerankerConfig = this.config.reranker;
        const endpoint = rerankerConfig.endpoint || this.getDefaultRerankerEndpoint(rerankerConfig.api);
        const apiKey = rerankerConfig.apiKey;
        if (!apiKey) {
            console.warn("[Ark KB] Reranker API key not configured, skipping rerank");
            return results;
        }
        try {
            const documents = results.map(r => r.entry.chunk_text);
            let response;
            switch (rerankerConfig.api) {
                case "siliconflow":
                    response = await fetch(endpoint || "https://api.siliconflow.cn/v1/rerank", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${apiKey}`,
                        },
                        body: JSON.stringify({
                            model: rerankerConfig.model || "BAAI/bge-m3",
                            query,
                            documents,
                            return_documents: false,
                        }),
                    });
                    break;
                case "cohere":
                    response = await fetch(endpoint || "https://api.cohere.ai/v1/rerank", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${apiKey}`,
                        },
                        body: JSON.stringify({
                            model: rerankerConfig.model || "rerank-multilingual-v3.0",
                            query,
                            documents,
                            top_n: documents.length,
                            return_documents: false,
                        }),
                    });
                    break;
                case "custom":
                    response = await fetch(endpoint, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${apiKey}`,
                        },
                        body: JSON.stringify({
                            model: rerankerConfig.model,
                            query,
                            documents,
                        }),
                    });
                    break;
                default:
                    return results;
            }
            if (!response.ok) {
                const err = await response.text();
                console.warn(`[Ark KB] Reranker API error (${response.status}): ${err}`);
                return results;
            }
            const data = await response.json();
            // SiliconFlow / generic rerank format: { results: [{ index, relevance_score }] }
            if (data.results && Array.isArray(data.results)) {
                const scored = data.results
                    .filter((r) => r.relevance_score >= minScore)
                    .map((r) => ({
                    entry: results[r.index].entry,
                    score: r.relevance_score,
                }))
                    .sort((a, b) => b.score - a.score);
                return scored;
            }
            // Cohere format: { results: [{ index, relevance }] }
            if (data.results && Array.isArray(data.results)) {
                const scored = data.results
                    .filter((r) => r.relevance >= minScore)
                    .map((r) => ({
                    entry: results[r.index].entry,
                    score: r.relevance,
                }))
                    .sort((a, b) => b.score - a.score);
                return scored;
            }
            console.warn("[Ark KB] Unknown reranker response format, returning un-scored results");
            return results;
        }
        catch (err) {
            console.warn(`[Ark KB] Reranker exception: ${err.message}, falling back to fusion scores`);
            return results;
        }
    }
    getDefaultRerankerEndpoint(api) {
        switch (api) {
            case "siliconflow": return "https://api.siliconflow.cn/v1/rerank";
            case "cohere": return "https://api.cohere.ai/v1/rerank";
            default: return "";
        }
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
    return results.map(r => ({ ...r, score: (r.score - min) / range }));
}
//# sourceMappingURL=searcher.js.map