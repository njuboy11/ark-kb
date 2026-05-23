/**
 * Ark KB — KBManager
 * Manages multiple knowledge bases as subfolders of knowledgePath.
 * Each KB = one LanceDB table (tableName = folder name).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { KnowledgeStore } from "./store.js";
import { Ingester } from "./ingester.js";
import { Embedder } from "./embedder.js";
// Type guard helpers (inline to avoid circular dependency with config.ts)
function detectEmbeddingApi(endpoint) {
    const u = endpoint.toLowerCase();
    if (u.includes("siliconflow"))
        return "siliconflow";
    if (u.includes("dashscope") || u.includes("aliyun"))
        return "dashscope";
    if (u.includes("openai"))
        return "openai";
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
    knowledgePath;
    dbPath;
    vectorDim;
    embedderConfig;
    kbs = new Map();
    ingesters = new Map();
    _videoConfig;
    _imageConfig;
    _modes;
    constructor(opts) {
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
        this._modes = {
            embeddingMode: opts.modes?.embeddingMode ?? "text",
            imageRerankerMode: opts.modes?.imageRerankerMode ?? "text",
            videoRerankerMode: opts.modes?.videoRerankerMode ?? "text",
        };
    }
    // -------------------------------------------------------------------------
    // Init — scan knowledgePath, auto-migrate root files, init all KB stores
    // -------------------------------------------------------------------------
    /**
     * Initialize: scan subfolders, auto-migrate root-level files to `default`,
     * then init() all KnowledgeStore instances.
     */
    async init() {
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
    async _autoMigrate() {
        const kp = this.knowledgePath;
        const entries = fs.readdirSync(kp, { withFileTypes: true });
        const rootFiles = entries.filter(e => e.isFile());
        if (rootFiles.length === 0)
            return;
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
    async _initKB(name) {
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
    _makeIngester(store) {
        const embedApi = this.embedderConfig.api ?? detectEmbeddingApi(this.embedderConfig.endpoint);
        const embedder = new Embedder({
            api: embedApi,
            endpoint: this.embedderConfig.endpoint,
            apiKey: this.embedderConfig.apiKey,
            model: this.embedderConfig.model,
            dimensions: this.vectorDim,
            batchSize: 16,
        });
        const pdfParser = { api: "none", endpoint: "", apiKey: "", model: "", params: {} };
        return new Ingester(store, embedder, { chunking: this.embedderConfig.chunking, pdfParser }, { endpoint: this._videoConfig.endpoint, apiKey: this._videoConfig.apiKey, maxFrames: this._videoConfig.maxFrames, timeoutMs: this._videoConfig.timeoutMs }, { endpoint: this._imageConfig.endpoint, apiKey: this._imageConfig.apiKey, timeoutMs: this._imageConfig.timeoutMs }, { embeddingMode: this._modes.embeddingMode, imageRerankerMode: this._modes.imageRerankerMode, videoRerankerMode: this._modes.videoRerankerMode });
    }
    // -------------------------------------------------------------------------
    // KB CRUD
    // -------------------------------------------------------------------------
    /**
     * Create a new knowledge base (subfolder + LanceDB table).
     */
    async createKB(name) {
        const sanitized = name.trim();
        if (!sanitized)
            throw new Error("[MultiKB] KB name cannot be empty");
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
    async deleteKB(name, confirm) {
        if (!this.kbs.has(name)) {
            throw new Error(`[MultiKB] KB "${name}" does not exist`);
        }
        if (!confirm) {
            return {
                message: `⚠️ Are you sure you want to delete KB "${name}"? This will remove all chunks and delete the folder. Reply with confirm=true to proceed.`,
                requiresConfirm: true,
            };
        }
        const store = this.kbs.get(name);
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
    async listKBs() {
        const results = [];
        for (const [name, store] of this.kbs.entries()) {
            try {
                const info = await store.tableInfo();
                results.push({
                    name,
                    path: path.join(this.knowledgePath, name),
                    fileCount: info.files.length,
                    chunkCount: info.chunks,
                });
            }
            catch {
                results.push({ name, path: path.join(this.knowledgePath, name), fileCount: 0, chunkCount: 0 });
            }
        }
        return results;
    }
    /**
     * Get a KnowledgeStore instance by KB name.
     */
    getKB(name) {
        return this.kbs.get(name);
    }
    /**
     * Get the name of the default KB ("default" if it exists, otherwise first KB).
     */
    getDefaultKBName() {
        if (this.kbs.has("default"))
            return "default";
        const first = this.kbs.keys().next().value;
        return first ?? "";
    }
    /**
     * Get all KB names.
     */
    getAllKBNames() {
        return [...this.kbs.keys()];
    }
    /**
     * Get an Ingester instance by KB name.
     */
    getIngester(name) {
        return this.ingesters.get(name);
    }
    /**
     * Re-ingest all files in a directory (heal/re-index).
     * Returns aggregate healed + skipped counts across all KBs.
     */
    async heal(knowledgePath) {
        let totalHealed = 0;
        let totalSkipped = 0;
        for (const [name, ingester] of this.ingesters.entries()) {
            const kbDir = path.join(knowledgePath, name);
            if (!fs.existsSync(kbDir))
                continue;
            try {
                const result = await ingester.heal(kbDir);
                totalHealed += result.healed;
                totalSkipped += result.skipped;
            }
            catch (err) {
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
    async searchAll(query, searchFn, topK = 5) {
        const tasks = [...this.kbs.entries()].map(async ([name, store]) => {
            try {
                const hits = await searchFn(store, query, topK);
                return hits.map(h => ({ ...h, kbName: name }));
            }
            catch (err) {
                console.warn(`[MultiKB] Search failed for KB "${name}": ${err.message}`);
                return [];
            }
        });
        const arrays = await Promise.all(tasks);
        const merged = arrays.flat();
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
     */
    async ingestByPath(filePath) {
        const resolved = path.resolve(filePath);
        const kbName = this._resolveKBForPath(resolved);
        const ingester = this.ingesters.get(kbName);
        if (!ingester) {
            throw new Error(`[MultiKB] No ingester for KB "${kbName}" — is the KB initialized?`);
        }
        const result = await ingester.ingestFile(resolved);
        return { ...result, kbName };
    }
    /**
     * Determine which KB a file belongs to based on its path.
     * Falls back to "default" if the immediate parent folder is not a known KB.
     */
    _resolveKBForPath(filePath) {
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
        if (this.kbs.has("default"))
            return "default";
        const first = this.kbs.keys().next().value;
        if (!first)
            throw new Error("[MultiKB] No KBs initialized — call init() first");
        return first;
    }
    // -------------------------------------------------------------------------
    // Remove from all KBs
    // -------------------------------------------------------------------------
    /**
     * Remove a file (by source path) from all knowledge bases.
     */
    async removeFromAll(sourcePath) {
        const results = [];
        for (const [name, store] of this.kbs.entries()) {
            try {
                const deleted = await store.deleteBySource(sourcePath);
                results.push({ kbName: name, deleted });
            }
            catch (err) {
                console.warn(`[MultiKB] removeFromAll failed for KB "${name}": ${err.message}`);
                results.push({ kbName: name, deleted: 0 });
            }
        }
        return results;
    }
    // -------------------------------------------------------------------------
    // Shutdown
    // -------------------------------------------------------------------------
    async close() {
        await Promise.all([...this.kbs.values()].map(s => s.close()));
        this.kbs.clear();
        this.ingesters.clear();
    }
}
//# sourceMappingURL=kb-manager.js.map