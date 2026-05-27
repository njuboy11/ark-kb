/**
 * Ark KB — Main Entry
 * Wires together all components with nested config support.
 * Exports definePluginEntry-compatible register function for OpenClaw.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
import { Ingester } from "./ingester.js";
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
import { Searcher } from "./searcher.js";

/**
 * Safely parse images field whether it's already an array or a JSON string.
 * Searcher.search() already parses images to array, so upstream callers
 * may receive arrays that should not be re-parsed.
 */
function safeParseImages(val: unknown): string[] {
  if (Array.isArray(val)) return val as string[];
  if (typeof val !== "string" || !val) return [];
  try { return JSON.parse(val) as string[]; } catch { return []; }
}

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
    if (!this._defaultSearcher) {
      throw new Error("[Ark KB] Searcher not ready — init() still running");
    }
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

  /** Promise that resolves when init() has finished (searcher/store ready). */
  private _ready: Promise<void>;
  private _resolveReady!: () => void;

  /** Searcher attached to the default KB (used when no specific kbName is given) */
  private _defaultSearcher!: Searcher;

  // Auto-compact scheduler
  private _compactTimer: ReturnType<typeof setTimeout> | null = null;
  private _compactStatePath = "";

  private _failedListPath = "";

  constructor(rawConfig: ArkKBConfig = {}) {
    this.config = resolveConfig(rawConfig);

    // Latch: searcher/store not ready until init() finishes
    this._ready = new Promise<void>((resolve) => { this._resolveReady = resolve; });

    const knowledgePath = expandPath(this.config.knowledgePath);
    const dbPath = expandPath(this.config.storage.dbPath);

    if (!knowledgePath) {
      throw new Error("[Ark KB] knowledgePath is empty — cannot initialize");
    }
    if (!existsSync(knowledgePath)) {
      mkdirSync(knowledgePath, { recursive: true });
    }
    if (!existsSync(dbPath)) {
      mkdirSync(dbPath, { recursive: true });
    }

    // Create KBManager — pass full config to avoid field-dropping bugs
    this.kbManager = new KBManager({
      knowledgePath,
      dbPath,
      vectorDim: this.config.embedding.dimensions,
      fullConfig: this.config,
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

    try {
      // Critical path: LanceDB + searcher — must always unlock
      await this.kbManager.init();

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
    } finally {
      // Unlock tools even if LanceDB fails — prevents permanent hang
      this._resolveReady();
    }

    // Non-critical: heal, watcher, email, compact can fail independently
    const kp = this.config.knowledgePath;
    // Initialize failed list path (used by watcher callback)
    this._failedListPath = join(kp, ".ark-kb-failed.json");
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

    console.log(`[Ark KB] Ready — ${total} chunks, ${files} files`);

    // Start auto-compact scheduler
    this._startAutoCompact();

    this._initialized = true;
  }

  // Latch: force callers to wait for init()
  private async _ensureReady(): Promise<void> {
    await this._ready;
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
      /** Filter by file type, e.g. "xlsx"/"pdf"/"docx" */
      fileType?: string;
    },
  ): Promise<any[]> {
    await this._ensureReady();

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
        fileType: options?.fileType,
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
        const hits = await s.search({ query: q, topK, resultCount: options?.resultCount, fileType: options?.fileType });
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
      images: safeParseImages(r.entry.images),
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
        images: safeParseImages(r.entry.images),
        file_type: r.entry.file_type,
        kbName: r.kbName,
      }));
    }

    try {
      // Rerank merged results from ALL KBs instead of re-searching default KB only
      const rc2 = this.config.reranker;
      if (rc2?.api && rc2.api !== "none" && rc2.apiKey) {
        const endpoint = rc2.endpoint || "https://api.siliconflow.cn/v1/rerank";
        const model = rc2.model || "BAAI/bge-reranker-v2-m3";
        const documents = results.map(r => r.entry.chunk_text?.substring(0, 2000) ?? "");

        const body: any = { model, query, documents, top_n: documents.length };
        const resp = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${rc2.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (resp.ok) {
          const data: any = await resp.json();
          const rerankResults = data.results ?? [];
          const minScore = options?.rerankerMinScore ?? rc2.minScore ?? 0;
          const topN = options?.resultCount ?? this.config.search.resultCount;
          // Build index→score map from reranker results
          const scoreMap = new Map<number, number>();
          for (const r2 of rerankResults) {
            if ((r2.relevance_score ?? 0) >= minScore) {
              scoreMap.set(r2.index, r2.relevance_score ?? 0);
            }
          }
          return results
            .filter((_, i) => scoreMap.has(i))
            .map(r => ({
              score: scoreMap.get(results.indexOf(r)) ?? r.score,
              chunk_text: r.entry.chunk_text?.substring(0, 500) ?? "",
              source_path: r.entry.source_path ?? "",
              chunk_index: r.entry.chunk_index ?? 0,
              total_chunks: r.entry.total_chunks ?? 0,
              images: safeParseImages(r.entry.images),
              file_type: r.entry.file_type ?? "",
              kbName: r.kbName,
            }))
            .sort((a: any, b: any) => b.score - a.score)
            .slice(0, topN);
        }
      }
      // Reranker call failed or unavailable — use un-reranked results
    } catch (err: any) {
      console.warn(`[Ark KB] Reranker API call failed: ${err.message} — falling back to un-reranked results`);
    }
    // Fallback: return un-reranked results
    return results.slice(0, options?.resultCount ?? this.config.search.resultCount).map(r => ({
      score: r.score,
      chunk_text: r.entry.chunk_text.substring(0, 500),
      source_path: r.entry.source_path,
      chunk_index: r.entry.chunk_index,
      total_chunks: r.entry.total_chunks,
      images: safeParseImages(r.entry.images),
      file_type: r.entry.file_type,
      kbName: r.kbName,
    }));
  }

  // -------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------

  async ingestFile(filePath: string) {
    await this._ensureReady();
    return await this.kbManager.ingestByPath(filePath);
  }

  // -------------------------------------------------------------------------
  // Remove
  // -------------------------------------------------------------------------

  async removeSource(sourcePath: string, kbName?: string): Promise<number> {
    await this._ensureReady();
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
    await this._ensureReady();
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
    await this._ensureReady();
    await this.kbManager.createKB(name);
  }

  async deleteKB(name: string, confirm: boolean): Promise<{
    message?: string;
    requiresConfirm?: boolean;
    deleted?: boolean;
    kbName?: string;
  }> {
    await this._ensureReady();
    return await this.kbManager.deleteKB(name, confirm);
  }

  async listKBs(): Promise<KBInfo[]> {
    await this._ensureReady();
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
    if (this._compactTimer) {
      clearTimeout(this._compactTimer);
      this._compactTimer = null;
    }
    await this.kbManager.close();
  }

  // ---------------------------------------------------------------------------
  // Auto-compact scheduler
  // ---------------------------------------------------------------------------

  private _startAutoCompact(): void {
    const { retentionDays, intervalDays } = this.config.compact;
    const intervalMs = intervalDays * 86_400_000;
    this._compactStatePath = join(this.config.knowledgePath, ".ark-kb-compact-last");

    const lastCompact = this._readLastCompactTime();
    const elapsed = lastCompact ? Date.now() - lastCompact : Infinity;

    if (!lastCompact || elapsed >= intervalMs) {
      // First run or overdue — execute immediately (don't use setTimeout(0)+unref, it may never fire)
      this._runAutoCompact();
    } else {
      // Wait until next scheduled time
      this._scheduleCompact(intervalMs - elapsed);
    }
  }

  private _scheduleCompact(delayMs: number): void {
    if (this._compactTimer) clearTimeout(this._compactTimer);
    this._compactTimer = setTimeout(() => {
      this._compactTimer = null;
      this._runAutoCompact();
    }, delayMs);
    if (this._compactTimer?.unref) this._compactTimer.unref();
  }

  private async _runAutoCompact(): Promise<void> {
    const { retentionDays, intervalDays } = this.config.compact;
    const startTime = Date.now();
    console.log(`[Ark KB] Auto-compact started (retentionDays=${retentionDays}, aggressive=${retentionDays < 7})`);

    try {
      const kbNames = this.kbManager.getAllKBNames();
      let totalBytes = 0;
      let totalFrags = 0;
      let totalPrune = 0;

      for (const kbName of kbNames) {
        try {
          const stats = await this.kbManager.compact(kbName, {
            cleanupDays: retentionDays,
            aggressive: retentionDays < 7,
            dryRun: false,
          });
          if (stats) {
            totalBytes += (stats.compaction?.bytesFreed ?? 0) + (stats.prune?.bytesRemoved ?? 0);
            totalFrags += stats.compaction?.fragmentsRemoved ?? 0;
            totalPrune += stats.prune?.oldVersionsRemoved ?? 0;
            console.log(`[Ark KB] Compacted "${kbName}": ${stats.durationMs}ms`);
          } else {
            console.log(`[Ark KB] Compacted "${kbName}": skipped (KB not found)`);
          }
        } catch (err: any) {
          console.warn(`[Ark KB] Auto-compact failed for KB "${kbName}": ${err.message}`);
        }
      }

      const dur = Date.now() - startTime;
      console.log(
        `[Ark KB] Auto-compact done (${dur}ms): ${kbNames.length} KBs, ` +
        `${totalFrags} fragments merged, ${totalPrune} old versions removed`
      );
    } catch (err: any) {
      console.error(`[Ark KB] Auto-compact error: ${err.message}`);
    } finally {
      // Write last compact timestamp (even on partial failure — we tried)
      this._writeLastCompactTime();
      // Schedule next run
      this._scheduleCompact(intervalDays * 86_400_000);
    }
  }

  private _readLastCompactTime(): number | null {
    try {
      if (existsSync(this._compactStatePath)) {
        const raw = readFileSync(this._compactStatePath, "utf8").trim();
        const ts = parseInt(raw, 10);
        return Number.isNaN(ts) ? null : ts;
      }
    } catch {/* ignore */}
    return null;
  }

  private _writeLastCompactTime(): void {
    try {
      writeFileSync(this._compactStatePath, String(Date.now()), "utf8");
    } catch (err: any) {
      console.warn(`[Ark KB] Failed to write compact state: ${err.message}`);
    }
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
    } catch (err: any) { console.error("[Ark KB] Failed to resolve LLM config:", err.message); return { endpoint: "", apiKey: "", model: "" }; }
  }

  private _emailIngesterInitialized = false;

  private async _initEmailIngester(api?: any): Promise<void> {
    if (this._emailIngesterInitialized) return;
    if (!this.config.emailIngester.enabled) return;

    const llmClient = this.getUserLLM();
    this.emailIngester = new EmailIngester({
      config: this.config.emailIngester,
      kbManager: this.kbManager,
      knowledgePath: this.config.knowledgePath,
      llmClient,
    });
    await this.emailIngester.init();
    this._emailIngesterInitialized = true;
  }

  /** Retry failed ingestions from persisted list. Not yet wired into init() — TODO. */
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

console.log("[Ark KB] register() called");
export function register(api: {
  registerTool: (tool: any, opts?: any) => void;
  registerRuntimeLifecycle: (lifecycle: { id: string; shutdown: () => Promise<void> }) => void;
  config?: Record<string, any>;
  pluginConfig?: Record<string, any>;
}): void {
  // Idempotent: OpenClaw may call register() multiple times (init + hot-restart)

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
    // Never auto-overwrite an existing config file — it may contain real credentials
    // that just happen to be in a format the loader can't parse right now.
    if (!existsSync(standalonePath)) {
      const examplePath = join(pluginDir, "plugin-config.example.json");
      if (existsSync(examplePath)) {
        console.log("[Ark KB] No standalone config found, auto-creating from example:", examplePath);
        copyFileSync(examplePath, standalonePath);
        console.log("[Ark KB] Created", standalonePath, "— edit this file to configure.");
        const retry = loadConfigFromFile(standalonePath);
        if (retry.config) {
          arkConfig = retry.config;
        } else {
          console.log("[Ark KB] Example config failed to load, falling back to openclaw.json");
          arkConfig = (api.pluginConfig ?? api.config ?? {}) as ArkKBConfig;
          fromOpenClaw = true;
        }
      } else {
        console.log("[Ark KB] No config files found, falling back to openclaw.json");
        arkConfig = (api.pluginConfig ?? api.config ?? {}) as ArkKBConfig;
        fromOpenClaw = true;
      }
    } else {
      console.error("[Ark KB] plugin-config.json exists but failed to parse.");
      console.error("[Ark KB] Fix the JSON syntax at:", standalonePath);
      console.error("[Ark KB] Refusing to start with degraded config — no openclaw.json fallback.");
      throw new Error(
        `[Ark KB] Configuration file "${standalonePath}" is invalid. ` +
        `Check JSON syntax or restore from backup.`
      );
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
