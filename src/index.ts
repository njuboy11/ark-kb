/**
 * Ark KB — Main Entry
 * Wires together all components with nested config support.
 */

import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { registerKBTools } from "./tools.js";
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
import { Ingester } from "./ingester.js";
import { Searcher } from "./searcher.js";
import { FileWatcher } from "./watcher.js";

// ============================================================================
// Raw config from openclaw.plugin.json
// ============================================================================

export interface RawConfig {
  knowledgePath?: string;
  storage?: { dbPath?: string };
  chunking?: {
    maxTokens?: number;
    overlapTokens?: number;
    strategy?: string;
  };
  embedding?: {
    api?: string;
    endpoint?: string;
    apiKey?: string;
    model?: string;
    dimensions?: number;
    batchSize?: number;
  };
  pdfParser?: {
    api?: string;
    endpoint?: string;
    apiKey?: string;
    model?: string;
  };
  reranker?: {
    api?: string;
    endpoint?: string;
    apiKey?: string;
    model?: string;
    minScore?: number;
  };
  search?: {
    vectorWeight?: number;
    topK?: number;
    resultCount?: number;
  };
  watcher?: {
    enabled?: boolean;
    paths?: string[];
    debounceMs?: number;
    ignorePatterns?: string[];
  };
}

// ============================================================================
// Resolved config (flat, with defaults)
// ============================================================================

export interface ResolvedConfig {
  knowledgePath: string;
  storage: { dbPath: string };
  chunking: {
    maxTokens: number;
    overlapTokens: number;
    strategy: "paragraph" | "fixed" | "sentence";
  };
  embedding: {
    api: "dashscope" | "siliconflow" | "openai" | "custom";
    endpoint: string;
    apiKey: string;
    model: string;
    dimensions: number;
    batchSize: number;
  };
  pdfParser: {
    api: "mineru" | "builtin" | "none";
    endpoint: string;
    apiKey: string;
    model: string;
  };
  reranker: {
    api: "siliconflow" | "cohere" | "custom" | "none";
    endpoint: string;
    apiKey: string;
    model: string;
    minScore: number;
  };
  search: {
    vectorWeight: number;
    topK: number;
    resultCount: number;
  };
  watcher: {
    enabled: boolean;
    paths: string[];
    debounceMs: number;
    ignorePatterns: string[];
  };
}

// ============================================================================
// Sub-config interfaces (passed to components)
// ============================================================================

export interface IngesterConfig {
  chunking: ResolvedConfig["chunking"];
  pdfParser: ResolvedConfig["pdfParser"];
}

export interface SearcherConfig {
  search: ResolvedConfig["search"];
  reranker: ResolvedConfig["reranker"];
}

export interface WatcherConfig {
  enabled: boolean;
  paths: string[];
  debounceMs: number;
  ignorePatterns: string[];
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULTS: ResolvedConfig = {
  knowledgePath: "",
  storage: { dbPath: "~/.ark-kb/lancedb" },
  chunking: {
    maxTokens: 400,
    overlapTokens: 50,
    strategy: "paragraph",
  },
  embedding: {
    api: "siliconflow",
    endpoint: "https://api.siliconflow.cn/v1/embeddings",
    apiKey: "",
    model: "Qwen3-VL-Embedding-8B",
    dimensions: 4096,
    batchSize: 16,
  },
  pdfParser: {
    api: "builtin",
    endpoint: "",
    apiKey: "",
    model: "doclayout_onnx",
  },
  reranker: {
    api: "none",
    endpoint: "",
    apiKey: "",
    model: "BAAI/bge-m3",
    minScore: 0.35,
  },
  search: {
    vectorWeight: 0.7,
    topK: 20,
    resultCount: 6,
  },
  watcher: {
    enabled: true,
    paths: [],
    debounceMs: 2000,
    ignorePatterns: ["*.tmp", "*.swp", "~*", ".*"],
  },
};

// ============================================================================
// Config resolution
// ============================================================================

function resolveDbPath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return p;
}

function resolveConfig(raw: RawConfig): ResolvedConfig {
  const embedding = raw.embedding;
  const reranker = raw.reranker;

  // Determine embedding endpoint from API type if not explicitly set
  let endpoint = embedding?.endpoint ?? "";
  if (!endpoint && embedding?.api) {
    switch (embedding.api) {
      case "dashscope":
        endpoint = endpoint || "https://dashscope.aliyuncs.com/api/v1/embeddings";
        break;
      case "siliconflow":
        endpoint = endpoint || "https://api.siliconflow.cn/v1/embeddings";
        break;
      case "openai":
        endpoint = endpoint || "https://api.openai.com/v1/embeddings";
        break;
      default:
        endpoint = endpoint || "";
    }
  }

  return {
    knowledgePath: raw.knowledgePath ?? DEFAULTS.knowledgePath,

    storage: {
      dbPath: resolveDbPath(raw.storage?.dbPath ?? DEFAULTS.storage.dbPath),
    },

    chunking: {
      maxTokens: raw.chunking?.maxTokens ?? DEFAULTS.chunking.maxTokens,
      overlapTokens: raw.chunking?.overlapTokens ?? DEFAULTS.chunking.overlapTokens,
      strategy: (raw.chunking?.strategy as any) ?? DEFAULTS.chunking.strategy,
    },

    embedding: {
      api: (embedding?.api as any) ?? DEFAULTS.embedding.api,
      endpoint,
      apiKey: embedding?.apiKey ?? DEFAULTS.embedding.apiKey,
      model: embedding?.model ?? DEFAULTS.embedding.model,
      dimensions: embedding?.dimensions ?? DEFAULTS.embedding.dimensions,
      batchSize: embedding?.batchSize ?? DEFAULTS.embedding.batchSize,
    },

    pdfParser: {
      api: (raw.pdfParser?.api as any) ?? DEFAULTS.pdfParser.api,
      endpoint: raw.pdfParser?.endpoint ?? DEFAULTS.pdfParser.endpoint,
      apiKey: raw.pdfParser?.apiKey ?? DEFAULTS.pdfParser.apiKey,
      model: raw.pdfParser?.model ?? DEFAULTS.pdfParser.model,
    },

    reranker: {
      api: (reranker?.api as any) ?? DEFAULTS.reranker.api,
      endpoint: reranker?.endpoint ?? DEFAULTS.reranker.endpoint,
      apiKey: reranker?.apiKey ?? DEFAULTS.reranker.apiKey,
      model: reranker?.model ?? DEFAULTS.reranker.model,
      minScore: reranker?.minScore ?? DEFAULTS.reranker.minScore,
    },

    search: {
      vectorWeight: raw.search?.vectorWeight ?? DEFAULTS.search.vectorWeight,
      topK: raw.search?.topK ?? DEFAULTS.search.topK,
      resultCount: raw.search?.resultCount ?? DEFAULTS.search.resultCount,
    },

    watcher: {
      enabled: raw.watcher?.enabled ?? DEFAULTS.watcher.enabled,
      paths: raw.watcher?.paths ?? DEFAULTS.watcher.paths,
      debounceMs: raw.watcher?.debounceMs ?? DEFAULTS.watcher.debounceMs,
      ignorePatterns: raw.watcher?.ignorePatterns ?? DEFAULTS.watcher.ignorePatterns,
    },
  };
}

// ============================================================================
// ArkKB — Main class
// ============================================================================

export class ArkKB {
  public store: KnowledgeStore;
  public embedder: Embedder;
  public ingester: Ingester;
  public searcher: Searcher;
  public watcher: FileWatcher;
  public config: ResolvedConfig;

  private _initialized = false;

  constructor(rawConfig: RawConfig = {}) {
    this.config = resolveConfig(rawConfig);

    // Ensure knowledge path exists
    const kp = this.config.knowledgePath;
    if (kp && !existsSync(kp)) {
      mkdirSync(kp, { recursive: true });
    }

    // Ensure DB directory exists
    if (!existsSync(this.config.storage.dbPath)) {
      mkdirSync(this.config.storage.dbPath, { recursive: true });
    }

    // Instantiate components
    this.store = new KnowledgeStore({
      dbPath: this.config.storage.dbPath,
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

    this.ingester = new Ingester(this.store, this.embedder, {
      chunking: this.config.chunking,
      pdfParser: this.config.pdfParser,
    });

    this.searcher = new Searcher(
      this.store,
      this.embedder,
      this.config.knowledgePath,
      {
        search: this.config.search,
        reranker: this.config.reranker,
      },
    );

    this.watcher = new FileWatcher({
      enabled: this.config.watcher.enabled,
      paths: this.config.watcher.paths,
      debounceMs: this.config.watcher.debounceMs,
      ignorePatterns: this.config.watcher.ignorePatterns,
    });
  }

  /**
   * Initialize the knowledge base: connect to LanceDB, optionally scan
   * the knowledge directory, and optionally start the file watcher.
   */
  async init(): Promise<void> {
    if (this._initialized) return;

    // 1. Initialize LanceDB store
    console.log("[Ark KB] Initializing LanceDB...");
    await this.store.init();

    // 2. Scan existing files
    const kp = this.config.knowledgePath;
    let total = 0;
    let files = 0;

    if (kp) {
      console.log(`[Ark KB] Scanning knowledge directory: ${kp}`);
      const result = await this.ingester.ingestDirectory(kp);
      total = result.total;
      files = result.files;
      console.log(`[Ark KB] Indexed ${files} files, ${total} chunks`);
    }

    // 3. Start file watcher
    if (this.config.watcher.enabled && kp) {
      this.watcher.start(kp, async (event, filePath) => {
        const base = filePath.split("/").pop() || filePath;

        if (event === "add" || event === "change") {
          try {
            await this.ingester.ingestFile(filePath);
          } catch (err: any) {
            console.error(`[Ark KB] Watcher ingest error (${filePath}): ${err.message}`);
          }
        } else if (event === "unlink") {
          try {
            const deleted = await this.store.deleteBySource(base);
            if (deleted > 0) {
              console.log(`[Ark KB] Removed: ${base} (${deleted} chunks)`);
            }
          } catch (err: any) {
            console.error(`[Ark KB] Watcher delete error (${base}): ${err.message}`);
          }
        }
      });
    }

    this._initialized = true;
    console.log(`[Ark KB] Ready — ${total} chunks, ${files} files`);
  }

  // ========================================================================
  // Public API
  // ========================================================================

  async search(query: string, options?: {
    topK?: number;
    rerankerEnabled?: boolean;
    rerankerMinScore?: number;
    resultCount?: number;
  }): Promise<any[]> {
    return await this.searcher.search({
      query,
      topK: options?.topK,
      rerankerEnabled: options?.rerankerEnabled,
      rerankerMinScore: options?.rerankerMinScore,
      resultCount: options?.resultCount,
    });
  }

  async ingestFile(filePath: string): Promise<{ entries: number; source: string; skipped: boolean }> {
    return await this.ingester.ingestFile(filePath);
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
    console.log("[Ark KB] Shutdown complete");
  }

  // Expose ingester for kb_ingest tool (full directory re-index)
  get ingesterInstance(): Ingester {
    return this.ingester;
  }

  /**
   * Register tools with OpenClaw.
   */
  getTools(): ReturnType<typeof registerKBTools> {
    return registerKBTools(this);
  }
}

export { registerKBTools };
