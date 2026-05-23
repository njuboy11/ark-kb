/**
 * Ark KB — Main Entry
 * Wires together all components with nested config support.
 * Exports definePluginEntry-compatible register function for OpenClaw.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
import { Ingester } from "./ingester.js";
import { Searcher } from "./searcher.js";
import { FileWatcher } from "./watcher.js";
import { KBManager, KBInfo } from "./kb-manager.js";
import { EmailIngester } from "./email-ingester.js";
import {
  ArkKBConfig,
  ResolvedConfig,
  resolveConfig,
  loadConfigFromFile,
  validateConfig,
} from "./config.js";
import { registerKBTools } from "./tools.js";

// ============================================================================
// ArkKB — Core class (used both by the plugin and for direct Node.js usage)
// ============================================================================

export class ArkKB {
  public config: ResolvedConfig;

  /** Primary multi-KB driver */
  public kbManager: KBManager;

  /** Embedder instance (kept for per-KB Searcher construction) */
  public embedder: Embedder;

  /** File watcher */
  public watcher: FileWatcher;

  /** Email auto-ingester (null when disabled) */
  private emailIngester: EmailIngester | null = null;

  // -------------------------------------------------------------------------
  // Backward-compatible aliases (tools depend on these properties)
  // -------------------------------------------------------------------------
  // store, searcher, ingester are accessed by tools.ts — we expose them
  // as getters that delegate to the "default" KB (or first KB if no default).
  // -------------------------------------------------------------------------

  /** Returns the default KB's KnowledgeStore (backward compat for tools) */
  public get store(): KnowledgeStore {
    const kbName = this.kbManager.getDefaultKBName?.() ?? "default";
    const store = this.kbManager.getKB(kbName);
    if (store) return store;
    // Fallback: try first available KB
    const firstName = this.kbManager.getAllKBNames()[0];
    if (firstName) {
      const fallback = this.kbManager.getKB(firstName);
      if (fallback) return fallback;
    }
    throw new Error("[Ark KB] No KBs initialized — call init() first");
  }

  /** Returns a Searcher attached to the default KB store (backward compat for tools) */
  public get searcher(): Searcher {
    return this._defaultSearcher;
  }

  /** Returns the default KB's Ingester (backward compat for tools) */
  public get ingester(): Ingester {
    const kbName = this.kbManager.getDefaultKBName?.() ?? "default";
    return this.kbManager.getIngester?.(kbName) ??
      (() => { throw new Error("[Ark KB] No KBs initialized — call init() first"); })();
  }

  // -------------------------------------------------------------------------
  // Private state
  // -------------------------------------------------------------------------

  private _initialized = false;

  /** Searcher attached to the default KB (used when no specific kbName is given) */
  private _defaultSearcher!: Searcher;

  private _failedListPath = "";

  constructor(rawConfig: ArkKBConfig = {}) {
    this.config = resolveConfig(rawConfig);

    const knowledgePath = expandPath(this.config.knowledgePath);
    const dbPath = expandPath(this.config.storage.dbPath);

    if (!existsSync(knowledgePath)) {
      mkdirSync(knowledgePath, { recursive: true });
    }
    if (!existsSync(dbPath)) {
      mkdirSync(dbPath, { recursive: true });
    }

    // Create KBManager — drives all KB operations
    this.kbManager = new KBManager({
      knowledgePath,
      dbPath,
      vectorDim: this.config.embedding.dimensions,
      embedderConfig: {
        api: this.config.embedding.api,
        endpoint: this.config.embedding.endpoint,
        apiKey: this.config.embedding.apiKey,
        model: this.config.embedding.model,
        chunking: this.config.chunking,
      },
      videoConfig: {
        endpoint: this.config.videoSummarizer.endpoint,
        apiKey: this.config.videoSummarizer.apiKey,
        maxFrames: this.config.videoSummarizer.maxFrames,
        timeoutMs: 120_000,
      },
      imageConfig: {
        endpoint: this.config.imageSummarizer.endpoint,
        apiKey: this.config.imageSummarizer.apiKey,
        timeoutMs: 60_000,
      },
      embeddingMethod: {
        image: this.config.embedding.method.image,
        video: this.config.embedding.method.video,
      },
    });

    // Embedder for query embedding (used in search)
    this.embedder = new Embedder({
      api: this.config.embedding.api,
      endpoint: this.config.embedding.endpoint,
      apiKey: this.config.embedding.apiKey,
      model: this.config.embedding.model,
      dimensions: this.config.embedding.dimensions,
      batchSize: this.config.embedding.batchSize,
    });

    this.watcher = new FileWatcher({
      enabled: this.config.watcher.enabled,
      paths: this.config.watcher.paths ?? [],
      debounceMs: this.config.watcher.debounceMs,
      ignorePatterns: this.config.watcher.ignorePatterns,
    });

    // emailIngester is initialized in init() after LLM config is resolved
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  async init(api?: any): Promise<void> {
    if (this._initialized) return;

    // KBManager.init() handles auto-migration + scanning + store init
    await this.kbManager.init();

    // Build default searcher (used when no specific KB is targeted)
    const defaultStore = this.store;
    this._defaultSearcher = new Searcher(
      defaultStore,
      this.embedder,
      this.config.knowledgePath,
      {
        search: this.config.search,
        reranker: this.config.reranker,
        method: {
          image: this.config.embedding.method.image,
          video: this.config.embedding.method.video,
        },
      },
    );

    const kp = this.config.knowledgePath;
    let total = 0;
    let files = 0;

    if (kp) {
      // Heal: re-index any files that were added while ArkKB was offline
      try {
        const result = await this.kbManager.heal?.(kp);
        if (result) {
          total = result.healed ?? 0;
          files = (result.healed ?? 0) + (result.skipped ?? 0);
          console.log(`[Ark KB] Healed ${result.healed} files, skipped ${result.skipped}`);
        }
      } catch (err: any) {
        console.warn(`[Ark KB] Heal skipped: ${err.message}`);
      }
    }

    // Start watcher on the knowledge path root (covers all KB subfolders)
    if (this.config.watcher.enabled && kp) {
      this.watcher.start(kp, async (event, filePath) => {
        const base = filePath.split("/").pop() || filePath;
        if (event === "add" || event === "change") {
          try {
            const result = await this.kbManager.ingestByPath(filePath);
            if (result.entries === 0 && !result.skipped) {
              this._markFailed(filePath);
            }
          } catch (err: any) {
            console.error(`[Ark KB] Watcher ingest error (${filePath}): ${err.message}`);
            this._markFailed(filePath);
          }
        } else if (event === "unlink") {
          try {
            // Try to remove from all KBs (best effort)
            await this.kbManager.removeFromAll(base);
          } catch (err: any) {
            console.error(`[Ark KB] Watcher delete error (${base}): ${err.message}`);
          }
        }
      });
    }

    // Initialize email auto-ingester (api param only used in plugin mode)
    await this._initEmailIngester(api);

    this._initialized = true;
    console.log(`[Ark KB] Ready — ${total} chunks, ${files} files`);
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async search(
    query: string,
    options?: {
      topK?: number;
      rerankerEnabled?: boolean;
      rerankerMinScore?: number;
      resultCount?: number;
      /** Target a specific KB; omit to search all KBs */
      kbName?: string;
    },
  ): Promise<any[]> {
    const methodConfig = {
      image: this.config.embedding.method.image,
      video: this.config.embedding.method.video,
    };

    // Specific KB requested
    if (options?.kbName) {
      const store = this.kbManager.getKB(options.kbName);
      if (!store) {
        throw new Error(`[Ark KB] KB "${options.kbName}" not found`);
      }
      const searcher = new Searcher(store, this.embedder, this.config.knowledgePath, {
        search: this.config.search,
        reranker: this.config.reranker,
        method: methodConfig,
      });
      return await searcher.search({
        query,
        topK: options?.topK,
        rerankerEnabled: options?.rerankerEnabled,
        rerankerMinScore: options?.rerankerMinScore,
        resultCount: options?.resultCount,
      });
    }

    // Search all KBs
    const results = await this.kbManager.searchAll(
      query,
      async (store, q, topK) => {
        const s = new Searcher(store, this.embedder, this.config.knowledgePath, {
          search: this.config.search,
          reranker: this.config.reranker,
          method: methodConfig,
        });
        // Searcher returns SearchResult[] — transform to { entry, score }[] for KBManager
        const hits = await s.search({ query: q, topK, resultCount: options?.resultCount });
        return hits.map(h => ({ entry: h, score: h.score }));
      },
      options?.topK ?? this.config.search.topK,
    );

    // Apply global reranking if enabled (rerank across all KB results)
    if (options?.rerankerEnabled !== false && this.config.reranker?.enabled !== false) {
      const reranked = await this._globalRerank(results, query, options);
      return reranked;
    }

    return results.map(r => ({
      score: r.score,
      chunk_text: r.entry.chunk_text.substring(0, 500),
      source_path: r.entry.source_path,
      chunk_index: r.entry.chunk_index,
      total_chunks: r.entry.total_chunks,
      images: JSON.parse(r.entry.images || "[]"),
      file_type: r.entry.file_type,
      kbName: r.kbName,
    }));
  }

  /**
   * Apply a second-stage rerank across merged multi-KB results.
   * Falls back to returning the input if reranking fails.
   */
  private async _globalRerank(
    results: { entry: any; score: number; kbName: string }[],
    query: string,
    options?: { rerankerMinScore?: number; resultCount?: number },
  ): Promise<any[]> {
    if (results.length === 0) return [];

    const rc = this.config.reranker;
    if (!rc?.api || rc.api === "none" || !rc.apiKey) {
      return results.slice(0, options?.resultCount ?? this.config.search.resultCount).map(r => ({
        score: r.score,
        chunk_text: r.entry.chunk_text.substring(0, 500),
        source_path: r.entry.source_path,
        chunk_index: r.entry.chunk_index,
        total_chunks: r.entry.total_chunks,
        images: JSON.parse(r.entry.images || "[]"),
        file_type: r.entry.file_type,
        kbName: r.kbName,
      }));
    }

    try {
      // Use the default searcher's rerank logic
      return await this._defaultSearcher.search({
        query,
        topK: results.length,
        rerankerEnabled: true,
        rerankerMinScore: options?.rerankerMinScore ?? rc.minScore,
        resultCount: options?.resultCount ?? this.config.search.resultCount,
      });
    } catch {
      return results.slice(0, options?.resultCount ?? this.config.search.resultCount).map(r => ({
        score: r.score,
        chunk_text: r.entry.chunk_text.substring(0, 500),
        source_path: r.entry.source_path,
        chunk_index: r.entry.chunk_index,
        total_chunks: r.entry.total_chunks,
        images: JSON.parse(r.entry.images || "[]"),
        file_type: r.entry.file_type,
        kbName: r.kbName,
      }));
    }
  }

  // -------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------

  async ingestFile(filePath: string) {
    return await this.kbManager.ingestByPath(filePath);
  }

  // -------------------------------------------------------------------------
  // Remove
  // -------------------------------------------------------------------------

  async removeSource(sourcePath: string, kbName?: string): Promise<number> {
    if (kbName) {
      const store = this.kbManager.getKB(kbName);
      if (!store) throw new Error(`[Ark KB] KB "${kbName}" not found`);
      return await store.deleteBySource(sourcePath);
    }
    // Remove from all KBs — return total deleted
    const results = await this.kbManager.removeFromAll(sourcePath);
    return results.reduce((sum, r) => sum + r.deleted, 0);
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  async status(kbName?: string): Promise<{
    chunkCount: number;
    sources: string[];
    kbName?: string;
  }> {
    if (kbName) {
      const store = this.kbManager.getKB(kbName);
      if (!store) throw new Error(`[Ark KB] KB "${kbName}" not found`);
      const [chunkCount, sources] = await Promise.all([
        store.count(),
        store.listSources(),
      ]);
      return { chunkCount, sources, kbName };
    }

    // Aggregate all KBs
    const kbs = await this.kbManager.listKBs();
    let totalChunks = 0;
    const allSources: string[] = [];
    const byKb: Record<string, { chunkCount: number; sources: string[] }> = {};

    for (const kb of kbs) {
      totalChunks += kb.chunkCount;
      try {
        const store = this.kbManager.getKB(kb.name);
        if (store) {
          const sources = await store.listSources();
          byKb[kb.name] = { chunkCount: kb.chunkCount, sources };
          allSources.push(...sources);
        }
      } catch { /* KB may be in transition */ }
    }

    return {
      chunkCount: totalChunks,
      sources: [...new Set(allSources)],
      // Also include per-KB breakdown in a special field
    } as any;
  }

  // -------------------------------------------------------------------------
  // KB management (new multi-KB API)
  // -------------------------------------------------------------------------

  async createKB(name: string): Promise<void> {
    await this.kbManager.createKB(name);
  }

  async deleteKB(name: string, confirm: boolean): Promise<{
    message?: string;
    requiresConfirm?: boolean;
    deleted?: boolean;
    kbName?: string;
  }> {
    return await this.kbManager.deleteKB(name, confirm);
  }

  async listKBs(): Promise<KBInfo[]> {
    return await this.kbManager.listKBs();
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    this.watcher.stop();
    if (this.emailIngester) {
      await this.emailIngester.shutdown();
      this.emailIngester = null;
    }
    await this.kbManager.close();
  }

  // -------------------------------------------------------------------------
  // Retry failed files (for backward compat)
  // -------------------------------------------------------------------------

  get ingesterInstance(): Ingester {
    return this.ingester;
  }

  /**
   * Get the user\'s LLM config from the OpenClaw plugin API or openclaw.json.
   * Used by EmailIngester for KB routing decisions.
   */
  /** Auto-detect LLM from openclaw.json. Priority: defaultModel → first text model with apiKey (top-down). */
  private getUserLLM(): { endpoint: string; apiKey: string; model: string } {
    const openclawPath = join(homedir(), ".openclaw", "openclaw.json");
    try {
      if (!existsSync(openclawPath)) return { endpoint: "", apiKey: "", model: "" };
      const raw = JSON.parse(readFileSync(openclawPath, "utf-8"));
      const providers = raw?.models?.providers as Record<string, any> | undefined;
      if (!providers) return { endpoint: "", apiKey: "", model: "" };

      // Helper: resolve alias to provider/model
      const resolveAlias = (alias: string): { providerKey: string; modelId: string } | null => {
        const mapping = raw?.models?.aliases?.[alias];
        if (!mapping) return null;
        const full = typeof mapping === "string" ? mapping : mapping.provider + "/" + mapping.model;
        const slashIdx = full.indexOf("/");
        if (slashIdx < 0) return null;
        return { providerKey: full.slice(0, slashIdx), modelId: full.slice(slashIdx + 1) };
      };

      const getEndpoint = (baseUrl: string | undefined): string => {
        if (!baseUrl) return "";
        const u = (baseUrl as string).replace(/\/+$/, "");
        return u.endsWith("/v1") ? `${u}/chat/completions` : `${u}/v1/chat/completions`;
      };

      // Priority 1: defaultModel
      const defaultAlias = raw?.models?.defaultModel as string | undefined;
      if (defaultAlias) {
        const resolved = resolveAlias(defaultAlias);
        if (resolved && providers[resolved.providerKey]?.apiKey) {
          const p = providers[resolved.providerKey];
          return { endpoint: getEndpoint(p.baseUrl), apiKey: p.apiKey, model: resolved.modelId };
        }
      }

      // Priority 2: first text model with apiKey (top-down)
      for (const prov of Object.values(providers)) {
        const p = prov as any;
        if (!p?.apiKey) continue;
        const textModel = (p.models as any[])?.find((m: any) => m.input?.includes("text"));
        if (textModel) return { endpoint: getEndpoint(p.baseUrl), apiKey: p.apiKey, model: textModel.id };
      }

      return { endpoint: "", apiKey: "", model: "" };
    } catch { return { endpoint: "", apiKey: "", model: "" }; }
  }

  private async _initEmailIngester(api?: any): Promise<void> {
    if (!this.config.emailIngester.enabled) return;

    const llmClient = this.getUserLLM();
    this.emailIngester = new EmailIngester({
      config: this.config.emailIngester,
      kbManager: this.kbManager,
      knowledgePath: this.config.knowledgePath,
      llmClient,
    });
    await this.emailIngester.init();
  }

  private async _retryFailed(knowledgePath: string): Promise<void> {
    const fs = await import("node:fs");
    const p = await import("node:path");
    this._failedListPath = p.join(knowledgePath, ".ark-kb-failed.json");
    if (!fs.existsSync(this._failedListPath)) return;

    let failed: string[] = [];
    try {
      failed = JSON.parse(fs.readFileSync(this._failedListPath, "utf-8"));
    } catch { return; }
    if (failed.length === 0) return;

    const remaining: string[] = [];
    for (const filePath of failed) {
      try {
        await this.kbManager.ingestByPath(filePath);
        console.log(`[Ark KB] Retry succeeded: ${p.basename(filePath)}`);
      } catch {
        remaining.push(filePath);
      }
    }
    if (remaining.length === 0) {
      fs.unlinkSync(this._failedListPath);
    } else {
      fs.writeFileSync(this._failedListPath, JSON.stringify(remaining, null, 2));
    }
  }

  private async _markFailed(filePath: string): Promise<void> {
    if (!this._failedListPath) return;
    const fs = await import("node:fs");
    let failed: string[] = [];
    if (fs.existsSync(this._failedListPath)) {
      try { failed = JSON.parse(fs.readFileSync(this._failedListPath, "utf-8")); } catch {}
    }
    if (!failed.includes(filePath)) {
      failed.push(filePath);
      fs.writeFileSync(this._failedListPath, JSON.stringify(failed, null, 2));
    }
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  getTools() {
    return registerKBTools(this);
  }
}

// ============================================================================
// Plugin entry — OpenClaw plugin registration
// ============================================================================

export function createPlugin(ark: ArkKB) {
  return {
    id: "@njuboy11/ark-kb",
    name: "ark-kb",
    description: "🏛️ Ark Knowledge Base — LanceDB + multimodal embedding RAG plugin",
    tools: ark.getTools().map(t => t.name),
  };
}

export function register(api: {
  registerTool: (tool: any, opts?: any) => void;
  registerRuntimeLifecycle: (lifecycle: { id: string; shutdown: () => Promise<void> }) => void;
  config?: Record<string, any>;
  pluginConfig?: Record<string, any>;
}): void {
  const pluginDir = import.meta.dirname!;
  const standalonePath = join(pluginDir, "plugin-config.json");

  const fileResult = loadConfigFromFile(standalonePath);

  if (fileResult.errors.length > 0) {
    console.error("[Ark KB] Config validation FAILED in", standalonePath);
    for (const err of fileResult.errors) {
      console.error(`  - ${err}`);
    }
    throw new Error(
      `[Ark KB] Configuration error in ${standalonePath}: ${fileResult.errors.join("; ")}`,
    );
  }

  let arkConfig: ArkKBConfig;
  let fromOpenClaw = false;

  if (fileResult.config) {
    console.log("[Ark KB] Loading config from standalone file:", standalonePath);
    arkConfig = fileResult.config;
  } else {
    const examplePath = join(pluginDir, "plugin-config.example.json");
    if (existsSync(examplePath)) {
      console.log("[Ark KB] No standalone config found, auto-creating from example:", examplePath);
      copyFileSync(examplePath, standalonePath);
      console.log("[Ark KB] Created", standalonePath, "— edit this file to configure.");
      const retry = loadConfigFromFile(standalonePath);
      if (retry.config) {
        arkConfig = retry.config;
      } else {
        console.log("[Ark KB] Falling back to openclaw.json");
        arkConfig = (api.pluginConfig ?? api.config ?? {}) as ArkKBConfig;
        fromOpenClaw = true;
      }
    } else {
      console.log("[Ark KB] No config files found, falling back to openclaw.json");
      arkConfig = (api.pluginConfig ?? api.config ?? {}) as ArkKBConfig;
      fromOpenClaw = true;
    }
  }

  if (fromOpenClaw) {
    const fallbackErrors = validateConfig(arkConfig);
    if (fallbackErrors.length > 0) {
      console.error("[Ark KB] Config validation FAILED (openclaw.json):");
      for (const err of fallbackErrors) {
        console.error(`  - ${err}`);
      }
      throw new Error(
        `[Ark KB] Configuration error in openclaw.json: ${fallbackErrors.join("; ")}`,
      );
    }
  }

  const ark = new ArkKB(arkConfig);

  for (const tool of ark.getTools()) {
    api.registerTool(tool);
  }

  ark.init().catch((err) => console.error('[Ark KB] Background init failed:', err));

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
// Re-exported types for backward compatibility
// ============================================================================

export interface IngesterConfig {
  chunking: ResolvedConfig["chunking"];
  pdfParser: ResolvedConfig["pdfParser"];
}

export interface SearcherConfig {
  search: ResolvedConfig["search"];
  reranker: ResolvedConfig["reranker"];
  method: {
    image: "text" | "multimodal";
    video: "text" | "multimodal";
  };
}

export interface WatcherConfig {
  enabled: boolean;
  paths: string[];
  debounceMs: number;
  ignorePatterns: string[];
}

/** Re-export KBManager and KBInfo for consumers */
export { KBManager, KBInfo } from "./kb-manager.js";
export type { KBEntry, KBSearchResult, StoreOptions } from "./kb-manager.js";
