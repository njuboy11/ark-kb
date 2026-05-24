/**
 * Ark KB — KnowledgeStore
 * LanceDB-backed vector store with FTS (BM25) support.
 * NO in-memory fallback — LanceDB failure throws.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";

/** Helper: collect all rows from LanceDB RecordBatchIterator (no .toArray()) */
async function collectRows(results: any): Promise<any[]> {
  if (Array.isArray(results)) return results;
  const rows: any[] = [];
  while (true) {
    const r = await results.next();
    if (r.done) break;
    const batch = r.value;
    if (batch?.toArray) {
      rows.push(...batch.toArray());
    }
  }
  return rows;
}

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
  images: string;         // JSON string array
  file_type: string;
  file_hash: string;
  created_at: number;
  updated_at: number;
}

export interface KBSearchResult {
  entry: KBEntry;
  score: number;
}

export interface StoreOptions {
  dbPath: string;
  vectorDim: number;
  tableName?: string;   // defaults to "default"
}

// ============================================================================
// KnowledgeStore
// ============================================================================

export class KnowledgeStore {
  private db: any = null;
  private table: any = null;
  private config: StoreOptions;
  private tableName: string;

  constructor(config: StoreOptions) {
    this.config = config;
    this.tableName = config.tableName ?? "default";
  }

  /**
   * List all table names in a LanceDB database.
   */
  static async listTables(opts: { dbPath: string }): Promise<string[]> {
    const lancedb = await import("@lancedb/lancedb");
    const dbDir = opts.dbPath.startsWith("~")
      ? path.join(process.env.HOME || "/root", opts.dbPath.slice(1))
      : opts.dbPath;
    const db = await lancedb.connect(dbDir);
    try {
      return await db.tableNames();
    } finally {
      if (db?.close) db.close();
    }
  }

  async init(): Promise<void> {
    const lancedb = await import("@lancedb/lancedb");

    // Ensure the DB directory exists
    const dbDir = this.config.dbPath.startsWith("~")
      ? path.join(process.env.HOME || "/root", this.config.dbPath.slice(1))
      : this.config.dbPath;
    fs.mkdirSync(dbDir, { recursive: true });

    this.db = await lancedb.connect(dbDir);
    const tableNames = await this.db.tableNames();

    if (tableNames.includes(this.tableName)) {
      this.table = await this.db.openTable(this.tableName);
    } else {
      // Create table with a dummy row then delete it
      this.table = await this.db.createTable(this.tableName, [
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

    // Ensure FTS index exists for BM25 search (always recreate if missing)
    try {
      const indices = await this.table.listIndices();
      const hasFts = indices.some((i: any) => i.name === "chunk_text_idx");
      if (!hasFts) {
        await this.table.createIndex("chunk_text", { config: lancedb.Index.fts({ withPosition: true }) });
        console.log(`[Ark KB] BM25 FTS index created on table "${this.tableName}"`);
      }
    } catch (err: any) {
      console.warn("[Ark KB] Failed to create FTS index:", err.message);
    }

    console.log(`[Ark KB] LanceDB connected: ${dbDir} [table="${this.tableName}"]`);
  }

  /**
   * Drop (delete) the current table from the database.
   */
  async drop(): Promise<void> {
    if (!this.db) {
      throw new Error("[Ark KB] Store not initialized — call init() first");
    }
    await this.db.dropTable(this.tableName);
    this.table = null;
    console.log(`[Ark KB] Table "${this.tableName}" dropped`);
  }

  /**
   * Return information about the current table.
   */
  async tableInfo(): Promise<{ chunks: number; files: string[] }> {
    if (!this.table) {
      throw new Error("[Ark KB] Store not initialized — call init() first");
    }
    const chunks = await this.table.countRows();
    const results = await this.table.query().select(["source_path"]).execute();
    const rows = await collectRows(results);
    const files = rows
      .map((r: any) => r.source_path)
      .filter((s: unknown): s is string => typeof s === "string" && s.length > 0);
    return { chunks, files: [...new Set(files)] };
  }

  /**
   * Insert KBEntry array in a single batch.
   */
  async insert(entries: KBEntry[]): Promise<void> {
    if (!this.table) {
      throw new Error("[Ark KB] Store not initialized — call init() first");
    }
    if (entries.length === 0) return;
    await this.table.add(entries);
  }

  /**
   * Vector ANN search.
   * Returns results sorted by distance score.
   */
  async search(queryVector: number[], topK: number): Promise<KBSearchResult[]> {
    if (!this.table) {
      throw new Error("[Ark KB] Store not initialized — call init() first");
    }

    const allResults = await this.table
      .search(queryVector, { columns: ["vector"] })
      .limit(topK * 3) // over-fetch for hybrid merge
      .execute();

    const rows = await collectRows(allResults);

    return rows.map((r: any) => ({
      entry: {
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
      } as KBEntry,
      score: r._distance ?? 0,
    }));
  }

  /**
   * BM25-style full-text search using LanceDB FTS.
   * Falls back to vector-only search if FTS is not available.
   */
  async searchBM25(query: string, topK: number): Promise<KBSearchResult[]> {
    if (!this.table) {
      throw new Error("[Ark KB] Store not initialized — call init() first");
    }

    try {
      // Try LanceDB FTS query (explicit fts type for LanceDB 0.26+)
      const ftsResults = await this.table
        .search(query, "fts")
        .limit(topK)
        .execute();

      const rows = await collectRows(ftsResults);

      return rows.map((r: any) => ({
        entry: {
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
        } as KBEntry,
        score: r._distance ?? 0,
      }));
    } catch {
      // FTS not available — return empty and rely on vector search
      return [];
    }
  }

  /**
   * Delete all entries belonging to a source path.
   * Returns the number of deleted entries.
   */
  async deleteBySource(sourcePath: string): Promise<number> {
    if (!this.table) {
      throw new Error("[Ark KB] Store not initialized — call init() first");
    }
    const before = await this.count();
    const escaped = sourcePath.replace(/'/g, "''");
    await this.table.delete(`source_path = '${escaped}'`);
    const after = await this.count();
    return before - after;
  }

  /**
   * List all unique source paths in the store.
   */
  async listSources(): Promise<string[]> {
    if (!this.table) {
      throw new Error("[Ark KB] Store not initialized — call init() first");
    }
    const results = await this.table.query().select(["source_path"]).execute();
    const rows = await collectRows(results);
    const paths = rows.map((r: any) => r.source_path).filter((s: unknown): s is string => typeof s === "string" && s.length > 0);
    return [...new Set<string>(paths)];
  }

  /**
   * Total number of chunk entries.
   */
  async count(): Promise<number> {
    if (!this.table) {
      throw new Error("[Ark KB] Store not initialized — call init() first");
    }
    return await this.table.countRows();
  }

  /**
   * Check if a file_hash exists in any source (third-layer deduplication).
   * Returns true if the hash is found in any entry, false otherwise.
   */
  async hasFileHash(hash: string): Promise<boolean> {
    if (!this.table) {
      throw new Error("[Ark KB] Store not initialized — call init() first");
    }
    const results = await this.table.query()
      .filter(`file_hash = '${hash}'`)
      .limit(1)
      .execute();
    const rows = await collectRows(results);
    return rows.length > 0;
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    if (this.db?.close) {
      this.db.close();
    }
    this.db = null;
    this.table = null;
  }
}
