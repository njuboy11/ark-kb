/**
 * Ark KB — KBManager
 * Manages multiple knowledge bases as subfolders of knowledgePath.
 * Each KB = one LanceDB table (tableName = folder name).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { KnowledgeStore } from "./store.js";
import { Ingester, hashFile } from "./ingester.js";
import { Embedder } from "./embedder.js";

// Re-export types for consumers
export type { KBEntry, KBSearchResult, StoreOptions } from "./store.js";

export interface KBInfo {
  name: string;
  path: string;
  fileCount: number;
  chunkCount: number;
}

export interface SearchResult {
  entry: any;
  score: number;
  kbName: string;
}

export interface IngestResult {
  entries: number;
  source: string;
  skipped: boolean;
  kbName: string;
}

export interface DeleteKBResult {
  message?: string;
  requiresConfirm?: boolean;
  deleted?: boolean;
  kbName?: string;
}

export interface RemoveResult {
  kbName: string;
  deleted: number;
}

/** Options for MultiKBManager */
export interface MultiKBOptions {
  knowledgePath: string;
  dbPath: string;
  vectorDim: number;
  /** Optional embedder config for ingestion (ingestByPath won't work without this) */
  embedderConfig?: {
    api?: string;
    endpoint?: string;
    apiKey?: string;
    model?: string;
    chunking?: { maxTokens: number; overlapTokens: number; strategy: "paragraph" | "fixed" | "sentence" };
  };
  /** Video summarizer config (needed for video text mode) */
  videoConfig?: { endpoint: string; apiKey: string; maxFrames: number; timeoutMs?: number };
  /** Image summarizer config (needed for image text mode) */
  imageConfig?: { endpoint: string; apiKey: string; timeoutMs: number };
  /** Embedding method per modality */
  embeddingMethod?: { image?: "text" | "multimodal"; video?: "text" | "multimodal" };
}

// Type guard helpers (inline to avoid circular dependency with config.ts)
function detectEmbeddingApi(endpoint: string): string {
  const u = endpoint.toLowerCase();
  if (u.includes("siliconflow")) return "siliconflow";
  if (u.includes("dashscope") || u.includes("aliyun")) return "dashscope";
  if (u.includes("openai")) return "openai";
  return "custom";
}

/**
 * MultiKBManager — manages multiple LanceDB-backed knowledge bases.
 *
 * Directory structure:
 *   knowledgePath/
 *     default/         ← default KB (tableName = "default")
 *       file1.md
 *       file2.pdf
 *     project-a/      ← KB named "project-a"
 *       readme.md
 *     project-b/
 *       ...
 */
export class KBManager {
  private knowledgePath: string;
  private dbPath: string;
  private vectorDim: number;
  private embedderConfig: { api: string; endpoint: string; apiKey: string; model: string; chunking: { maxTokens: number; overlapTokens: number; strategy: "paragraph" | "fixed" | "sentence" } };
  private kbs: Map<string, KnowledgeStore> = new Map();
  private ingesters: Map<string, Ingester> = new Map();
  private _videoConfig: { endpoint: string; apiKey: string; maxFrames: number; timeoutMs: number };
  private _imageConfig: { endpoint: string; apiKey: string; timeoutMs: number };
  private _embeddingMethod: { image: "text" | "multimodal"; video: "text" | "multimodal" };

  constructor(opts: MultiKBOptions) {
    this.knowledgePath = opts.knowledgePath;
    this.dbPath = opts.dbPath;
    this.vectorDim = opts.vectorDim;
    this.embedderConfig = {
      api: opts.embedderConfig?.api ?? "",
      endpoint: opts.embedderConfig?.endpoint ?? "",
      apiKey: opts.embedderConfig?.apiKey ?? "",
      model: opts.embedderConfig?.model ?? "text-embedding-3-small",
      chunking: opts.embedderConfig?.chunking ?? { maxTokens: 512, overlapTokens: 64, strategy: "paragraph" },
    };
    this._videoConfig = {
      endpoint: opts.videoConfig?.endpoint ?? "",
      apiKey: opts.videoConfig?.apiKey ?? "",
      maxFrames: opts.videoConfig?.maxFrames ?? 100,
      timeoutMs: opts.videoConfig?.timeoutMs ?? 120_000,
    };
    this._imageConfig = {
      endpoint: opts.imageConfig?.endpoint ?? "",
      apiKey: opts.imageConfig?.apiKey ?? "",
      timeoutMs: opts.imageConfig?.timeoutMs ?? 60_000,
    };
    this._embeddingMethod = {
      image: opts.embeddingMethod?.image ?? "text",
      video: opts.embeddingMethod?.video ?? "text",
    };
  }

  // -------------------------------------------------------------------------
  // Init — scan knowledgePath, auto-migrate root files, init all KB stores
  // -------------------------------------------------------------------------

  /**
   * Initialize: scan subfolders, auto-migrate root-level files to `default`,
   * then init() all KnowledgeStore instances.
   */
  async init(): Promise<void> {
    const kp = this.knowledgePath;
    fs.mkdirSync(kp, { recursive: true });

    // Auto-migrate: if root has files (not dirs), create `default` and move them
    await this._autoMigrate();

    // Scan subfolders
    const entries = fs.readdirSync(kp, { withFileTypes: true });
    const subDirs = entries.filter(e => e.isDirectory()).map(e => e.name);

    // Init each KB store in parallel
    await Promise.all(subDirs.map(name => this._initKB(name)));
  }

  /** Auto-migrate root-level files to a `default` KB. */
  private async _autoMigrate(): Promise<void> {
    const kp = this.knowledgePath;
    const entries = fs.readdirSync(kp, { withFileTypes: true });
    const rootFiles = entries.filter(e => e.isFile());

    if (rootFiles.length === 0) return;

    const defaultDir = path.join(kp, "default");
    fs.mkdirSync(defaultDir, { recursive: true });

    for (const entry of rootFiles) {
      const src = path.join(kp, entry.name);
      const dst = path.join(defaultDir, entry.name);
      fs.renameSync(src, dst);
      console.log(`[MultiKB] Migrated root file to default KB: ${entry.name}`);
    }

    console.log(`[MultiKB] Auto-migration complete: ${rootFiles.length} file(s) moved to "default"`);
  }

  /** Init a single KB store (creates folder if missing + inits KnowledgeStore). */
  private async _initKB(name: string): Promise<void> {
    const kbDir = path.join(this.knowledgePath, name);
    fs.mkdirSync(kbDir, { recursive: true });

    const store = new KnowledgeStore({
      dbPath: this.dbPath,
      vectorDim: this.vectorDim,
      tableName: name,
    });

    await store.init();
    this.kbs.set(name, store);
    this.ingesters.set(name, this._makeIngester(store));
  }

  /** Build a minimal Ingester for the given store (PDF parsing disabled, no media summarizers). */
  private _makeIngester(store: KnowledgeStore): Ingester {
    const embedApi = this.embedderConfig.api ?? detectEmbeddingApi(this.embedderConfig.endpoint);
    const embedder = new Embedder({
      api: embedApi,
      endpoint: this.embedderConfig.endpoint,
      apiKey: this.embedderConfig.apiKey,
      model: this.embedderConfig.model,
      dimensions: this.vectorDim,
      batchSize: 16,
    });
    const pdfParser = this.embedderConfig.pdfParser ?? { api: "none" as const, endpoint: "", apiKey: "", model: "", params: {} };
    return new Ingester(
      store,
      embedder,
      { chunking: this.embedderConfig.chunking, pdfParser },
      { endpoint: this._videoConfig.endpoint, apiKey: this._videoConfig.apiKey, maxFrames: this._videoConfig.maxFrames, timeoutMs: this._videoConfig.timeoutMs },
      { endpoint: this._imageConfig.endpoint, apiKey: this._imageConfig.apiKey, timeoutMs: this._imageConfig.timeoutMs },
      { imageMethod: this._embeddingMethod.image, videoMethod: this._embeddingMethod.video },
    );
  }

  // -------------------------------------------------------------------------
  // KB CRUD
  // -------------------------------------------------------------------------

  /**
   * Create a new knowledge base (subfolder + LanceDB table).
   */
  async createKB(name: string): Promise<void> {
    const sanitized = name.trim();
    if (!sanitized) throw new Error("[MultiKB] KB name cannot be empty");
    if (this.kbs.has(sanitized)) {
      throw new Error(`[MultiKB] KB "${sanitized}" already exists`);
    }
    await this._initKB(sanitized);
    console.log(`[MultiKB] Created KB: "${sanitized}"`);
  }

  /**
   * Delete a knowledge base.
   * @param name KB name
   * @param confirm Must be true to execute deletion
   * @returns confirmation prompt if confirm=false, otherwise deletes and returns result
   */
  async deleteKB(name: string, confirm: boolean): Promise<DeleteKBResult> {
    if (!this.kbs.has(name)) {
      throw new Error(`[MultiKB] KB "${name}" does not exist`);
    }
    if (!confirm) {
      return {
        message: `⚠️ Are you sure you want to delete KB "${name}"? This will remove all chunks and delete the folder. Reply with confirm=true to proceed.`,
        requiresConfirm: true,
      };
    }

    const store = this.kbs.get(name)!;
    await store.drop();
    this.kbs.delete(name);
    this.ingesters.delete(name);

    // Remove the folder
    const kbDir = path.join(this.knowledgePath, name);
    fs.rmSync(kbDir, { recursive: true, force: true });

    console.log(`[MultiKB] Deleted KB: "${name}"`);
    return { deleted: true, kbName: name };
  }

  /**
   * List all knowledge bases with file count and chunk count.
   */
  async listKBs(): Promise<KBInfo[]> {
    const results: KBInfo[] = [];
    for (const [name, store] of this.kbs.entries()) {
      try {
        const info = await store.tableInfo();
        results.push({
          name,
          path: path.join(this.knowledgePath, name),
          fileCount: info.files.length,
          chunkCount: info.chunks,
        });
      } catch {
        results.push({ name, path: path.join(this.knowledgePath, name), fileCount: 0, chunkCount: 0 });
      }
    }
    return results;
  }

  /**
   * Get a KnowledgeStore instance by KB name.
   */
  getKB(name: string): KnowledgeStore | undefined {
    return this.kbs.get(name);
  }

  /**
   * Get the name of the default KB ("default" if it exists, otherwise first KB).
   */
  getDefaultKBName(): string {
    if (this.kbs.has("default")) return "default";
    const first = this.kbs.keys().next().value;
    return first ?? "";
  }

  /**
   * Get all KB names.
   */
  getAllKBNames(): string[] {
    return [...this.kbs.keys()];
  }

  /**
   * Get an Ingester instance by KB name.
   */
  getIngester(name: string): Ingester | undefined {
    return this.ingesters.get(name);
  }

  /**
   * Re-ingest all files in a directory (heal/re-index).
   * Returns aggregate healed + skipped counts across all KBs.
   */
  async heal(knowledgePath: string): Promise<{ healed: number; skipped: number }> {
    let totalHealed = 0;
    let totalSkipped = 0;
    for (const [name, ingester] of this.ingesters.entries()) {
      const kbDir = path.join(knowledgePath, name);
      if (!fs.existsSync(kbDir)) continue;
      try {
        const result = await ingester.heal(kbDir);
        totalHealed += result.healed;
        totalSkipped += result.skipped;
      } catch (err: any) {
        console.warn(`[KBManager] heal skip for KB "${name}": ${err.message}`);
      }
    }
    return { healed: totalHealed, skipped: totalSkipped };
  }

  // -------------------------------------------------------------------------
  // Search across all KBs
  // -------------------------------------------------------------------------

  /**
   * Search all knowledge bases and merge/rank results.
   * @param query Query string
   * @param searchFn Function that takes (KnowledgeStore, query, topK) and returns search results
   * @param topK Top results per KB (default 5)
   */
  async searchAll(
    query: string,
    searchFn: (store: KnowledgeStore, query: string, topK: number) => Promise<{ entry: any; score: number }[]>,
    topK = 5,
  ): Promise<SearchResult[]> {
    const tasks = [...this.kbs.entries()].map(async ([name, store]) => {
      try {
        const hits = await searchFn(store, query, topK);
        return hits.map(h => ({ ...h, kbName: name }));
      } catch (err: any) {
        console.warn(`[MultiKB] Search failed for KB "${name}": ${err.message}`);
        return [];
      }
    });

    const arrays = await Promise.all(tasks);
    const merged: SearchResult[] = arrays.flat();

    // Sort by score descending
    merged.sort((a, b) => b.score - a.score);
    return merged;
  }

  // -------------------------------------------------------------------------
  // File ingestion
  // -------------------------------------------------------------------------

  /**
   * Ingest a file into the appropriate KB based on its path.
   * Determines KB by the folder the file is in.
   *
   * Three-layer deduplication:
   * Layer 1 — same name + same hash: skip (filesystem)
   * Layer 2 — same name + different hash: rename with _1, _2 suffix (filesystem)
   * Layer 3 — different name + same hash: skip (DB hash check in ingester)
   */
  async ingestByPath(filePath: string): Promise<IngestResult> {
    const resolved = path.resolve(filePath);
    const kbName = this._resolveKBForPath(resolved);
    const kbPath = path.join(this.knowledgePath, kbName);

    // Layers 1 & 2: filesystem deduplication
    const destName = path.basename(resolved);
    const destPath = path.join(kbPath, destName);

    if (fs.existsSync(destPath)) {
      // Compute both hashes to decide: skip or rename
      const [newHash, oldHash] = await Promise.all([
        hashFile(resolved),
        hashFile(destPath),
      ]);

      if (newHash === oldHash) {
        // Layer 1: same name + same hash → skip
        console.log(`[MultiKB] Skipping duplicate (same name + hash): ${destName}`);
        return { entries: 0, source: destName, skipped: true, kbName };
      }

      // Layer 2: same name + different hash → rename
      const uniqueName = this._getUniqueFilename(destName, kbPath);
      const uniquePath = path.join(kbPath, uniqueName);
      fs.copyFileSync(resolved, uniquePath);
      console.log(`[MultiKB] Renamed to avoid conflict: ${destName} → ${uniqueName}`);
      const result = await this.ingesters.get(kbName)!.ingestFile(uniquePath);
      return { ...result, kbName };
    }

    // No conflict — copy file to KB folder and ingest
    fs.copyFileSync(resolved, destPath);

    const ingester = this.ingesters.get(kbName);
    if (!ingester) {
      throw new Error(`[MultiKB] No ingester for KB "${kbName}" — is the KB initialized?`);
    }
    const result = await ingester.ingestFile(destPath);
    return { ...result, kbName };
  }

  /**
   * Generate a unique filename by appending _1, _2, etc. if conflicts exist.
   */
  private _getUniqueFilename(baseName: string, kbPath: string): string {
    const ext = path.extname(baseName);
    const stem = path.basename(baseName, ext);
    let i = 1;
    while (fs.existsSync(path.join(kbPath, `${stem}_${i}${ext}`))) {
      i++;
    }
    return `${stem}_${i}${ext}`;
  }

  /**
   * Determine which KB a file belongs to based on its path.
   * Falls back to "default" if the immediate parent folder is not a known KB.
   */
  private _resolveKBForPath(filePath: string): string {
    const kp = path.resolve(this.knowledgePath);
    const abs = path.resolve(filePath);

    // Walk up from the file's parent until we hit or exceed knowledgePath
    let current = path.dirname(abs);
    while (current !== kp && current !== path.dirname(kp)) {
      const parent = path.dirname(current);
      const folderName = path.basename(current);
      if (this.kbs.has(folderName)) {
        // Check the parent actually matches knowledgePath/<folderName>
        const expectedParent = path.join(kp, folderName);
        if (path.resolve(parent) === kp && path.resolve(current) === expectedParent) {
          return folderName;
        }
      }
      current = parent;
    }

    // If file is directly under knowledgePath root, try to match top folder name
    const rel = path.relative(kp, abs);
    const topFolder = rel.split(path.sep)[0];
    if (topFolder && this.kbs.has(topFolder)) {
      return topFolder;
    }

    // Fallback to "default" if it exists, otherwise first KB
    if (this.kbs.has("default")) return "default";
    const first = this.kbs.keys().next().value;
    if (!first) throw new Error("[MultiKB] No KBs initialized — call init() first");
    return first;
  }

  // -------------------------------------------------------------------------
  // Remove from all KBs
  // -------------------------------------------------------------------------

  /**
   * Remove a file (by source path) from all knowledge bases.
   */
  async removeFromAll(sourcePath: string): Promise<RemoveResult[]> {
    const results: RemoveResult[] = [];
    for (const [name, store] of this.kbs.entries()) {
      try {
        const deleted = await store.deleteBySource(sourcePath);
        results.push({ kbName: name, deleted });
      } catch (err: any) {
        console.warn(`[MultiKB] removeFromAll failed for KB "${name}": ${err.message}`);
        results.push({ kbName: name, deleted: 0 });
      }
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    await Promise.all([...this.kbs.values()].map(s => s.close()));
    this.kbs.clear();
    this.ingesters.clear();
  }
}
