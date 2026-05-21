/**
 * Ark KB — Knowledge Store
 * LanceDB-backed vector store with in-memory fallback and BM25 inverted index.
 */

import { randomUUID } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

export interface KBEntry {
  id: string;
  chunk_text: string;
  vector: number[];
  source_path: string;
  chunk_index: number;
  total_chunks: number;
  images: string;       // JSON-serialized string array
  file_type: string;
  file_hash: string;
  created_at: number;
  updated_at: number;
}

export interface KBSearchResult {
  entry: KBEntry;
  score: number;
}

export interface StoreConfig {
  dbPath: string;
  vectorDim: number;
}

// ============================================================================
// BM25 Inverted Index
// ============================================================================

interface BM25Entry {
  entry: KBEntry;
  termFreqs: Map<string, number>;
}

export class BM25Index {
  private entries: BM25Entry[] = [];
  private idf: Map<string, number> = new Map();
  private avgDocLen = 0;
  private k1 = 1.5;
  private b = 0.75;

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }

  build(entries: KBEntry[]): void {
    this.entries = [];
    let totalLen = 0;

    for (const entry of entries) {
      const terms = this.tokenize(entry.chunk_text);
      const termFreqs = new Map<string, number>();
      for (const term of terms) {
        termFreqs.set(term, (termFreqs.get(term) ?? 0) + 1);
      }
      this.entries.push({ entry, termFreqs });
      totalLen += terms.length;
    }

    this.avgDocLen = totalLen / Math.max(this.entries.length, 1);

    // Compute IDF for each term
    const docFreq = new Map<string, number>();
    for (const { termFreqs } of this.entries) {
      for (const term of termFreqs.keys()) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }
    const N = this.entries.length;
    this.idf.clear();
    for (const [term, df] of docFreq) {
      this.idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1));
    }
  }

  search(queryText: string, k: number): Array<{ entry: KBEntry; bm25Score: number }> {
    if (this.entries.length === 0) return [];

    const queryTerms = this.tokenize(queryText);
    if (queryTerms.length === 0) return [];

    const results: Array<{ entry: KBEntry; bm25Score: number }> = [];

    for (const { entry, termFreqs } of this.entries) {
      let score = 0;
      const docLen = [...termFreqs.values()].reduce((a, b) => a + b, 0);

      for (const qterm of queryTerms) {
        const tf = termFreqs.get(qterm) ?? 0;
        if (tf === 0) continue;
        const idf = this.idf.get(qterm) ?? 0;
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / this.avgDocLen));
        score += idf * (numerator / denominator);
      }

      if (score > 0) {
        results.push({ entry, bm25Score: score });
      }
    }

    return results.sort((a, b) => b.bm25Score - a.bm25Score).slice(0, k);
  }
}

// ============================================================================
// Knowledge Store
// ============================================================================

export class KnowledgeStore {
  private db: any = null;
  private table: any = null;
  private config: StoreConfig;
  private inMemoryStore: Map<string, KBEntry[]> = new Map();
  private useInMemory = true;
  private bm25Index = new BM25Index();

  constructor(config: StoreConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    try {
      const lancedb = await import("@lancedb/lancedb");
      this.db = await lancedb.connect(this.config.dbPath);
      const tableNames = await this.db.tableNames();

      if (tableNames.includes("knowledge_base")) {
        this.table = await this.db.openTable("knowledge_base");
      } else {
        // Create table with schema
        this.table = await this.db.createTable("knowledge_base", [
          {
            id: "dummy_init",
            chunk_text: "",
            vector: new Array(this.config.vectorDim).fill(0),
            source_path: "",
            chunk_index: 0,
            total_chunks: 0,
            images: "[]",
            file_type: "",
            file_hash: "",
            created_at: 0,
            updated_at: 0,
          },
        ]);
        await this.table.delete('id = "dummy_init"');
      }
      this.useInMemory = false;
      console.log(`[Ark KB] LanceDB connected: ${this.config.dbPath}`);
    } catch (err) {
      console.warn("[Ark KB] LanceDB unavailable, using in-memory mode:", err);
      this.useInMemory = true;
    }
  }

  async insert(entries: KBEntry[]): Promise<void> {
    if (!this.useInMemory && this.table) {
      await this.table.add(entries);
    } else {
      for (const entry of entries) {
        const key = entry.source_path;
        const existing = this.inMemoryStore.get(key) ?? [];
        existing.push(entry);
        this.inMemoryStore.set(key, existing);
      }
    }
    // Rebuild BM25 index
    const allEntries = await this.getAllEntries();
    this.bm25Index.build(allEntries);
  }

  private async getAllEntries(): Promise<KBEntry[]> {
    if (!this.useInMemory && this.table) {
      try {
        const results = await this.table.query().toArray();
        if (Array.isArray(results)) return results as KBEntry[];
      } catch {
        // fall through
      }
    }
    const all: KBEntry[] = [];
    for (const entries of this.inMemoryStore.values()) {
      all.push(...entries);
    }
    return all;
  }

  async vectorSearch(queryVector: number[], k: number): Promise<KBSearchResult[]> {
    if (!this.useInMemory && this.table) {
      try {
        let lanceResults: any;
        if (typeof this.table.search === "function") {
          lanceResults = await this.table.search(queryVector).limit(k).toArray();
        } else {
          // Legacy vector search API
          lanceResults = await this.table.search(queryVector, { k });
        }

        let rows: any[] = [];
        if (Array.isArray(lanceResults)) {
          rows = lanceResults;
        } else if (lanceResults && typeof (lanceResults as any).toArray === "function") {
          rows = await (lanceResults as any).toArray();
        }

        return rows.map((r) => ({
          entry: this.rowToEntry(r),
          score: r._distance ?? 0,
        }));
      } catch (err) {
        console.warn("[Ark KB] LanceDB vector search failed, falling back:", err);
      }
    }

    // In-memory fallback: cosine similarity
    return this.inMemoryVectorSearch(queryVector, k);
  }

  private inMemoryVectorSearch(queryVector: number[], k: number): KBSearchResult[] {
    const results: KBSearchResult[] = [];
    for (const entries of this.inMemoryStore.values()) {
      for (const entry of entries) {
        if (!entry.vector || entry.vector.length === 0) continue;
        const score = cosineSimilarity(queryVector, entry.vector);
        results.push({ entry, score });
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, k);
  }

  async bm25Search(queryText: string, k: number): Promise<Array<{ entry: KBEntry; bm25Score: number }>> {
    // Ensure index is fresh
    if (this.bm25Index) {
      const allEntries = await this.getAllEntries();
      this.bm25Index.build(allEntries);
    }
    return this.bm25Index.search(queryText, k);
  }

  /**
   * Fuse vector and BM25 results using weighted score fusion.
/**
   * Fuse vector and BM25 scores using the specified method.
   *
   * Methods:
   * - min_max: Normalize each list to [0,1] with min-max scaling, then weighted sum.
   * - z_score: Standardize each list (mean=0, stddev=1), then weighted sum.
   * - rrf: Reciprocal Rank Fusion — rank-based, ignoring score magnitudes.
   * - raw: Weighted sum of raw scores (assumes scores are comparable).
   */
  fuseResults(
    vectorResults: KBSearchResult[],
    bm25Results: Array<{ entry: KBEntry; bm25Score: number }>,
    vectorWeight: number,
    method: "min_max" | "z_score" | "rrf" | "raw" = "min_max",
  ): KBSearchResult[] {
    switch (method) {
      case "min_max":
        return this.fuseMinMax(vectorResults, bm25Results, vectorWeight);
      case "z_score":
        return this.fuseZScore(vectorResults, bm25Results, vectorWeight);
      case "rrf":
        return this.fuseRRF(vectorResults, bm25Results, vectorWeight);
      case "raw":
        return this.fuseRaw(vectorResults, bm25Results, vectorWeight);
      default:
        return this.fuseMinMax(vectorResults, bm25Results, vectorWeight);
    }
  }

  private fuseMinMax(
    vectorResults: KBSearchResult[],
    bm25Results: Array<{ entry: KBEntry; bm25Score: number }>,
    vectorWeight: number,
  ): KBSearchResult[] {
    const allEntries = new Map<string, KBSearchResult>();
    const bm25Weight = 1 - vectorWeight;

    if (vectorResults.length > 0) {
      const vMin = Math.min(...vectorResults.map((r) => r.score));
      const vMax = Math.max(...vectorResults.map((r) => r.score));
      const vRange = vMax - vMin || 1;
      for (const r of vectorResults) {
        allEntries.set(r.entry.id, { entry: r.entry, score: ((r.score - vMin) / vRange) * vectorWeight });
      }
    }

    if (bm25Results.length > 0) {
      const bMin = Math.min(...bm25Results.map((r) => r.bm25Score));
      const bMax = Math.max(...bm25Results.map((r) => r.bm25Score));
      const bRange = bMax - bMin || 1;
      for (const { entry, bm25Score } of bm25Results) {
        const norm = ((bm25Score - bMin) / bRange) * bm25Weight;
        const existing = allEntries.get(entry.id);
        if (existing) existing.score += norm;
        else allEntries.set(entry.id, { entry, score: norm });
      }
    }

    return [...allEntries.values()].sort((a, b) => b.score - a.score);
  }

  private fuseZScore(
    vectorResults: KBSearchResult[],
    bm25Results: Array<{ entry: KBEntry; bm25Score: number }>,
    vectorWeight: number,
  ): KBSearchResult[] {
    const allEntries = new Map<string, KBSearchResult>();
    const bm25Weight = 1 - vectorWeight;

    const zNorm = (scores: number[]): Map<number, number> => {
      const n = scores.length;
      if (n < 2) return new Map(scores.map((_, i) => [i, 0.5])); // single item → neutral
      const mean = scores.reduce((a, b) => a + b, 0) / n;
      const variance = scores.reduce((a, s) => a + (s - mean) ** 2, 0) / n;
      const std = Math.sqrt(variance) || 1;
      const normalized = new Map<number, number>();
      for (let i = 0; i < n; i++) {
        // Clamp z-score to [-3, 3], then map to [0, 1]
        const z = Math.max(-3, Math.min(3, (scores[i] - mean) / std));
        normalized.set(i, (z + 3) / 6);
      }
      return normalized;
    };

    if (vectorResults.length > 0) {
      const vNorm = zNorm(vectorResults.map((r) => r.score));
      for (let i = 0; i < vectorResults.length; i++) {
        allEntries.set(vectorResults[i].entry.id, {
          entry: vectorResults[i].entry,
          score: (vNorm.get(i) ?? 0.5) * vectorWeight,
        });
      }
    }

    if (bm25Results.length > 0) {
      const bNorm = zNorm(bm25Results.map((r) => r.bm25Score));
      for (let i = 0; i < bm25Results.length; i++) {
        const norm = (bNorm.get(i) ?? 0.5) * bm25Weight;
        const existing = allEntries.get(bm25Results[i].entry.id);
        if (existing) existing.score += norm;
        else allEntries.set(bm25Results[i].entry.id, { entry: bm25Results[i].entry, score: norm });
      }
    }

    return [...allEntries.values()].sort((a, b) => b.score - a.score);
  }

  private fuseRRF(
    vectorResults: KBSearchResult[],
    bm25Results: Array<{ entry: KBEntry; bm25Score: number }>,
    vectorWeight: number,
  ): KBSearchResult[] {
    const K = 60; // RRF constant
    const allEntries = new Map<string, KBSearchResult>();
    const bm25Weight = 1 - vectorWeight;

    // Assign ranks (1-indexed)
    const vSorted = [...vectorResults].sort((a, b) => b.score - a.score);
    const bSorted = [...bm25Results].sort((a, b) => b.bm25Score - a.bm25Score);

    for (let rank = 0; rank < vSorted.length; rank++) {
      const rrf = vectorWeight / (K + rank + 1);
      allEntries.set(vSorted[rank].entry.id, { entry: vSorted[rank].entry, score: rrf });
    }

    for (let rank = 0; rank < bSorted.length; rank++) {
      const rrf = bm25Weight / (K + rank + 1);
      const existing = allEntries.get(bSorted[rank].entry.id);
      if (existing) existing.score += rrf;
      else allEntries.set(bSorted[rank].entry.id, { entry: bSorted[rank].entry, score: rrf });
    }

    return [...allEntries.values()].sort((a, b) => b.score - a.score);
  }

  private fuseRaw(
    vectorResults: KBSearchResult[],
    bm25Results: Array<{ entry: KBEntry; bm25Score: number }>,
    vectorWeight: number,
  ): KBSearchResult[] {
    const allEntries = new Map<string, KBSearchResult>();
    const bm25Weight = 1 - vectorWeight;

    for (const r of vectorResults) {
      allEntries.set(r.entry.id, { entry: r.entry, score: r.score * vectorWeight });
    }

    for (const { entry, bm25Score } of bm25Results) {
      const existing = allEntries.get(entry.id);
      if (existing) existing.score += bm25Score * bm25Weight;
      else allEntries.set(entry.id, { entry, score: bm25Score * bm25Weight });
    }

    return [...allEntries.values()].sort((a, b) => b.score - a.score);
  }

  async deleteBySource(sourcePath: string): Promise<number> {
    if (!this.useInMemory && this.table) {
      try {
        const before = await this.count();
        await this.table.delete(`source_path = '${escapeSqlLiteral(sourcePath)}'`);
        const after = await this.count();
        const deleted = before - after;

        // Rebuild BM25
        const allEntries = await this.getAllEntries();
        this.bm25Index.build(allEntries);

        return deleted;
      } catch (err) {
        console.warn("[Ark KB] LanceDB delete failed, falling back:", err);
      }
    }

    const entries = this.inMemoryStore.get(sourcePath);
    this.inMemoryStore.delete(sourcePath);
    const count = entries?.length ?? 0;

    // Rebuild BM25
    const allEntries = await this.getAllEntries();
    this.bm25Index.build(allEntries);

    return count;
  }

  async listSources(): Promise<string[]> {
    if (!this.useInMemory && this.table) {
      try {
        const rows: any[] = await this.table.query().select(["source_path"]).toArray();
        return [...new Set(rows.map((r: any) => r.source_path).filter(Boolean))];
      } catch {
        // fall through
      }
    }
    return [...this.inMemoryStore.keys()];
  }

  async count(): Promise<number> {
    if (!this.useInMemory && this.table) {
      try {
        return await this.table.countRows();
      } catch {
        // fall through
      }
    }
    let total = 0;
    for (const entries of this.inMemoryStore.values()) {
      total += entries.length;
    }
    return total;
  }

  async close(): Promise<void> {
    if (this.db?.close) {
      this.db.close();
    }
    this.db = null;
    this.table = null;
  }

  private rowToEntry(r: any): KBEntry {
    return {
      id: r.id ?? "",
      chunk_text: r.chunk_text ?? "",
      vector: r.vector ?? [],
      source_path: r.source_path ?? "",
      chunk_index: r.chunk_index ?? 0,
      total_chunks: r.total_chunks ?? 1,
      images: r.images ?? "[]",
      file_type: r.file_type ?? "",
      file_hash: r.file_hash ?? "",
      created_at: r.created_at ?? 0,
      updated_at: r.updated_at ?? 0,
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
