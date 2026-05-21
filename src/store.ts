/**
 * Ark KB — LanceDB Storage Layer
 * 负责向量索引的写入、搜索和管理
 *
 * ⚠️ 本文件为初始脚手架，实际实现将参考
 *    memory-lancedb-pro 插件中的 store.ts
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
  images: string;          // JSON string array
  file_type: string;       // "md" | "png" | "jpg" | "pdf" | etc.
  file_hash: string;       // 文件内容 hash，用于检测变更
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
// LanceDB Store (Scaffold)
// ============================================================================

export class KnowledgeStore {
  private db: any = null;
  private table: any = null;
  private config: StoreConfig;
  private inMemoryStore: Map<string, KBEntry[]> = new Map();
  private useInMemory: boolean = true; // fallback until LanceDB API is finalized

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
        // 删除 dummy 记录
        await this.table.delete('id = "dummy_init"');
      }
      this.useInMemory = false;
      console.log(`[Ark KB] LanceDB 已连接: ${this.config.dbPath}`);
    } catch (err) {
      console.warn("[Ark KB] LanceDB 不可用，使用内存模式:", err);
      this.useInMemory = true;
    }
  }

  async insert(entries: KBEntry[]): Promise<void> {
    if (!this.useInMemory && this.table) {
      await this.table.add(entries);
    } else {
      // 内存模式
      for (const entry of entries) {
        const key = entry.source_path;
        const existing = this.inMemoryStore.get(key) || [];
        existing.push(entry);
        this.inMemoryStore.set(key, existing);
      }
    }
  }

  async search(
    queryVector: number[],
    topK: number,
  ): Promise<KBSearchResult[]> {
    if (!this.useInMemory && this.table) {
      const lanceResults = await this.table.search(queryVector).limit(topK).execute();

      // Convert LanceDB result format to KBSearchResult[]
      // TODO: Handle exact result format based on LanceDB version
      if (Array.isArray(lanceResults)) {
        // Modern LanceDB returns arrays
        return (lanceResults as any[]).map((r) => ({
          entry: {
            id: r.id || "",
            chunk_text: r.chunk_text || "",
            vector: r.vector || [],
            source_path: r.source_path || "",
            chunk_index: r.chunk_index || 0,
            total_chunks: r.total_chunks || 1,
            images: r.images || "[]",
            file_type: r.file_type || "",
            file_hash: r.file_hash || "",
            created_at: r.created_at || 0,
            updated_at: r.updated_at || 0,
          },
          score: (r as any)._distance ?? 0,
        }));
      }

      // Legacy format
      if (lanceResults && typeof (lanceResults as any).toArray === "function") {
        const arr = await (lanceResults as any).toArray();
        return arr.map((r: any) => ({
          entry: r as KBEntry,
          score: r._distance ?? 0,
        }));
      }
    }

    // 内存模式：暴力余弦相似度搜索
    return this.inMemorySearch(queryVector, topK);
  }

  private inMemorySearch(queryVector: number[], topK: number): KBSearchResult[] {
    const results: KBSearchResult[] = [];

    for (const entries of this.inMemoryStore.values()) {
      for (const entry of entries) {
        const score = cosineSimilarity(queryVector, entry.vector);
        results.push({ entry, score });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async deleteBySource(sourcePath: string): Promise<number> {
    if (!this.useInMemory && this.table) {
      const before = await this.table.countRows();
      await this.table.delete(`source_path = '${escapeSqlLiteral(sourcePath)}'`);
      const after = await this.table.countRows();
      return before - after;
    }

    const entries = this.inMemoryStore.get(sourcePath);
    this.inMemoryStore.delete(sourcePath);
    return entries?.length || 0;
  }

  async listSources(): Promise<string[]> {
    if (!this.useInMemory && this.table) {
      const results = (await this.table.query().select(["source_path"]).execute()) as any[];
      if (Array.isArray(results)) {
        return [...new Set(results.map((r: any) => r.source_path as string))];
      }
      // Legacy iterable
      if (results && typeof (results as any).toArray === "function") {
        const arr = await (results as any).toArray();
        return [...new Set(arr.map((r: any) => r.source_path as string))] as string[];
      }
    }
    return [...this.inMemoryStore.keys()];
  }

  async count(): Promise<number> {
    if (!this.useInMemory && this.table) {
      return await this.table.countRows();
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
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
