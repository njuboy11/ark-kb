/**
 * Ark KB — Main Entry
 * Initializes and wires together Store, Embedder, Ingester, Searcher, and Watcher.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
import { Ingester } from "./ingester.js";
import { Searcher } from "./searcher.js";
import { FileWatcher } from "./watcher.js";
import { ArkKBConfig, ResolvedConfig, resolveConfig } from "./config.js";
import { registerKBTools } from "./tools.js";

// ============================================================================
// ArkKB
// ============================================================================

export class ArkKB {
  public store: KnowledgeStore;
  public embedder: Embedder;
  public ingester: Ingester;
  public searcher: Searcher;
  public watcher: FileWatcher;
  public config: ResolvedConfig;

  private initialized = false;

  constructor(config: ArkKBConfig) {
    this.config = resolveConfig(config);

    // Expand ~ in paths
    const dbPath = expandPath(this.config.storage.dbPath);
    const knowledgePath = this.config.knowledgePath;

    // Ensure directories exist
    if (knowledgePath && !existsSync(knowledgePath)) {
      mkdirSync(knowledgePath, { recursive: true });
    }
    if (!existsSync(dbPath)) {
      mkdirSync(dbPath, { recursive: true });
    }

    // Wire up components
    this.store = new KnowledgeStore({
      dbPath,
      vectorDim: this.config.embedding.dimensions,
    });

    this.embedder = new Embedder({
      api: this.config.embedding.api,
      endpoint: this.config.embedding.endpoint,
      apiKey: this.config.embedding.apiKey,
      model: this.config.embedding.model,
      dimensions: this.config.embedding.dimensions,
      batchSize: this.config.embedding.batchSize,
    });

    this.ingester = new Ingester(this.store, this.embedder, this.config);
    this.searcher = new Searcher(this.store, this.embedder, this.config);
    this.watcher = new FileWatcher();
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    // 1. Initialize LanceDB
    console.log("[Ark KB] Initializing LanceDB...");
    await this.store.init();

    // 2. Ingest knowledge directory
    if (this.config.knowledgePath) {
      console.log("[Ark KB] Ingesting knowledge directory...");
      const { total, files } = await this.ingester.ingestDirectory(this.config.knowledgePath);
      console.log(`[Ark KB] Indexed ${files} files, ${total} chunks total`);

      // 3. Start file watcher
      if (this.config.watcher.enabled) {
        this.watcher.start(
          this.config.knowledgePath,
          async (event, filePath) => {
            if (event === "add" || event === "change") {
              await this.ingester.ingestFile(filePath);
            } else if (event === "unlink") {
              const base = filePath.split("/").pop() ?? filePath;
              const deleted = await this.store.deleteBySource(base);
              console.log(`[Ark KB] Removed: ${base} (${deleted} chunks)`);
            }
          },
          this.config.watcher.debounceMs,
          this.config.watcher.ignorePatterns,
        );
        console.log(`[Ark KB] File watcher active: ${this.config.knowledgePath}`);
      }
    } else {
      console.log("[Ark KB] No knowledgePath configured; skipping auto-ingest and watcher.");
    }

    this.initialized = true;
    console.log("[Ark KB] Ready.");
  }

  // ========================================================================
  // Public API
  // ========================================================================

  async search(query: string, options?: Partial<import("./searcher.js").SearchOptions>): Promise<import("./searcher.js").SearchResult[]> {
    return await this.searcher.search({
      query,
      topK: options?.topK ?? this.config.search.topK,
      resultCount: options?.resultCount ?? this.config.search.resultCount,
      vectorWeight: options?.vectorWeight ?? this.config.search.vectorWeight,
      bm25Enabled: options?.bm25Enabled ?? this.config.search.bm25Enabled,
      rerankerEnabled: options?.rerankerEnabled ?? (this.config.reranker.api !== "none"),
      rerankerMinScore: options?.rerankerMinScore ?? this.config.reranker.minScore,
    });
  }

  async ingestFile(filePath: string): Promise<{ entries: number; source: string }> {
    return await this.ingester.ingestFile(filePath);
  }

  async ingestDirectory(): Promise<{ total: number; files: number }> {
    if (!this.config.knowledgePath) {
      return { total: 0, files: 0 };
    }
    return await this.ingester.ingestDirectory(this.config.knowledgePath);
  }

  async removeSource(sourcePath: string): Promise<number> {
    return await this.store.deleteBySource(sourcePath);
  }

  async status(): Promise<{ chunkCount: number; sources: string[] }> {
    const [chunkCount, sources] = await Promise.all([
      this.store.count(),
      this.store.listSources(),
    ]);
    return { chunkCount, sources };
  }

  async shutdown(): Promise<void> {
    this.watcher.stop();
    await this.store.close();
    console.log("[Ark KB] Shutdown complete.");
  }

  /**
   * Returns the tool registration array for OpenClaw.
   */
  getTools() {
    return registerKBTools(this);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

// Re-export types
export type { ArkKBConfig, ResolvedConfig } from "./config.js";
export type { SearchOptions, SearchResult, SourceContent } from "./searcher.js";
