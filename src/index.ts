/**
 * Ark KB — Main Entry
 * Wires together all components with nested config support.
 * Exports definePluginEntry-compatible register function for OpenClaw.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
import { Ingester } from "./ingester.js";
import { Searcher } from "./searcher.js";
import { FileWatcher } from "./watcher.js";
import {
  ArkKBConfig,
  ResolvedConfig,
  resolveConfig,
} from "./config.js";
import { registerKBTools } from "./tools.js";

// ============================================================================
// ArkKB — Core class (used both by the plugin and for direct Node.js usage)
// ============================================================================

export class ArkKB {
  public store: KnowledgeStore;
  public embedder: Embedder;
  public ingester: Ingester;
  public searcher: Searcher;
  public watcher: FileWatcher;
  public config: ResolvedConfig;

  private _initialized = false;

  constructor(rawConfig: ArkKBConfig = {}) {
    this.config = resolveConfig(rawConfig);

    const dbPath = expandPath(this.config.storage.dbPath);
    if (!existsSync(dbPath)) {
      mkdirSync(dbPath, { recursive: true });
    }

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
      paths: this.config.watcher.paths ?? [],
      debounceMs: this.config.watcher.debounceMs,
      ignorePatterns: this.config.watcher.ignorePatterns,
    });
  }

  async init(): Promise<void> {
    if (this._initialized) return;

    await this.store.init();

    const kp = this.config.knowledgePath;
    let total = 0;
    let files = 0;

    if (kp) {
      const result = await this.ingester.heal(kp);
      total = result.healed;
      files = result.healed + result.skipped;
      console.log(`[Ark KB] Healed ${result.healed} files, skipped ${result.skipped}`);
    }

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
            await this.store.deleteBySource(base);
          } catch (err: any) {
            console.error(`[Ark KB] Watcher delete error (${base}): ${err.message}`);
          }
        }
      });
    }

    // Periodic heal: every 10 min, scan for files missed due to network issues
    if (kp) {
      const healInterval = setInterval(() => {
        this.ingester.heal(kp).then(r => {
          if (r.healed > 0) console.log(`[Ark KB] Periodic heal: ${r.healed} files re-indexed`);
        }).catch(e => console.error('[Ark KB] Periodic heal error:', e));
      }, 10 * 60 * 1000);
      // Don't block process exit
      if (healInterval.unref) healInterval.unref();
    }

    this._initialized = true;
    console.log(`[Ark KB] Ready — ${total} chunks, ${files} files`);
  }

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

  async ingestFile(filePath: string) {
    return await this.ingester.ingestFile(filePath);
  }

  async removeSource(sourcePath: string): Promise<number> {
    return await this.store.deleteBySource(sourcePath);
  }

  async status() {
    const [chunkCount, sources] = await Promise.all([
      this.store.count(),
      this.store.listSources(),
    ]);
    return { chunkCount, sources };
  }

  async shutdown(): Promise<void> {
    this.watcher.stop();
    await this.store.close();
  }

  get ingesterInstance(): Ingester {
    return this.ingester;
  }

  getTools() {
    return registerKBTools(this);
  }
}

// ============================================================================
// Plugin entry — OpenClaw plugin registration
// ============================================================================

/**
 * Creates the OpenClaw plugin definition.
 * Compatible with both TypeScript source and compiled JS output.
 */
export function createPlugin(ark: ArkKB) {
  return {
    id: "@njuboy11/ark-kb",
    name: "ark-kb",
    description: "🏛️ Ark Knowledge Base — LanceDB + multimodal embedding RAG plugin",
    tools: ark.getTools().map(t => t.name),
  };
}

// ============================================================================
// OpenClaw plugin entry point (CommonJS compat)
// The actual OpenClaw loader looks for `register` or a default-exported
// plugin definition.  We export both patterns for maximum compatibility.
// ============================================================================

export function register(api: {
  registerTool: (tool: any, opts?: any) => void;
  registerRuntimeLifecycle: (lifecycle: { id: string; shutdown: () => Promise<void> }) => void;
  config?: Record<string, any>;
  pluginConfig?: Record<string, any>;
}): void {
  const pluginConfig = (api.pluginConfig ?? api.config ?? {}) as ArkKBConfig;
  const ark = new ArkKB(pluginConfig);

  // Register all tools
  for (const tool of ark.getTools()) {
    api.registerTool(tool);
  }

  // Initialize in background (OpenClaw plugin API doesn't support async activate lifecycle)
  ark.init().catch((err) => console.error('[Ark KB] Background init failed:', err));

  // Register cleanup lifecycle
  api.registerRuntimeLifecycle({
    id: "ark-kb",
    async shutdown() {
      await ark.shutdown();
    },
  });
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

// ============================================================================
// Re-exported types for backward compatibility with internal imports
// (ingester, searcher, watcher import these from "./index.js")
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
