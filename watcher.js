/**
 * Ark KB — File Watcher
 * Monitors one or more directories for file changes and triggers re-indexing.
 * Configurable debounce, file stability check, and ignore patterns.
 */
import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
// ============================================================================
// FileWatcher
// ============================================================================
export class FileWatcher {
    watchers = [];
    handler = null;
    debounceTimers = new Map();
    fileSizes = new Map();
    config;
    constructor(config = {}) {
        this.config = {
            enabled: config.enabled ?? true,
            paths: config.paths ?? [],
            debounceMs: config.debounceMs ?? 2000,
            ignorePatterns: config.ignorePatterns ?? ["*.tmp", "*.swp", "~*", ".*"],
        };
    }
    /**
     * Start watching the primary knowledge path and any additional configured paths.
     */
    start(knowledgePath, handler) {
        this.handler = handler;
        // Watch primary path
        this.watchPath(knowledgePath);
        // Watch additional paths
        for (const extraPath of this.config.paths ?? []) {
            this.watchPath(extraPath);
        }
        console.log(`[Ark KB] File watcher started — debounce: ${this.config.debounceMs}ms, ` +
            `ignores: ${(this.config.ignorePatterns ?? []).join(", ")}`);
    }
    watchPath(watchPath) {
        const watcher = watch(watchPath, { recursive: true }, async (event, filename) => {
            if (!filename)
                return;
            if (!this.handler)
                return;
            const filePath = `${watchPath}/${filename}`;
            // Apply ignore patterns
            if (shouldIgnore(filename, this.config.ignorePatterns ?? []))
                return;
            if (event === "rename") {
                // rename can mean new file arrived or file was deleted
                try {
                    const s = await stat(filePath);
                    if (s.isFile()) {
                        await this.debouncedDispatch("add", filePath);
                    }
                }
                catch {
                    // File no longer exists → deleted
                    await this.handler("unlink", filePath);
                }
            }
            else if (event === "change") {
                await this.debouncedDispatch("change", filePath);
            }
        });
        this.watchers.push(watcher);
    }
    /**
     * Debounce events: wait for file size to stabilize before triggering.
     * This prevents re-indexing a file that is still being written.
     */
    async debouncedDispatch(event, filePath) {
        // Clear any pending timer for this file
        const existing = this.debounceTimers.get(filePath);
        if (existing)
            clearTimeout(existing);
        // Check if file is still being written: wait for size stability
        if (event === "add" || event === "change") {
            try {
                const s = await stat(filePath);
                const prevSize = this.fileSizes.get(filePath) ?? -1;
                if (prevSize === s.size && s.size > 0) {
                    // File size is stable — trigger immediately
                    this.debounceTimers.delete(filePath);
                    this.fileSizes.delete(filePath);
                    await this.safeHandler(event, filePath);
                    return;
                }
                this.fileSizes.set(filePath, s.size);
            }
            catch {
                // File disappeared
                this.debounceTimers.delete(filePath);
                this.fileSizes.delete(filePath);
                return;
            }
        }
        // Set debounce timer
        const timer = setTimeout(async () => {
            this.debounceTimers.delete(filePath);
            // Final stability check
            try {
                await stat(filePath);
            }
            catch {
                return; // File is gone
            }
            await this.safeHandler(event, filePath);
        }, this.config.debounceMs ?? 2000);
        this.debounceTimers.set(filePath, timer);
    }
    async safeHandler(event, filePath) {
        try {
            await this.handler(event, filePath);
        }
        catch (err) {
            console.error(`[Ark KB] File watcher handler error for ${filePath}: ${err.message}`);
        }
    }
    /**
     * Stop all watchers and clear timers.
     */
    stop() {
        for (const watcher of this.watchers) {
            watcher.close();
        }
        this.watchers = [];
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.fileSizes.clear();
        this.handler = null;
        console.log("[Ark KB] File watcher stopped");
    }
}
// ============================================================================
// Ignore pattern matching
// ============================================================================
function shouldIgnore(filename, patterns) {
    const base = basename(filename);
    for (const pattern of patterns) {
        // Glob: *.ext
        if (pattern.startsWith("*.")) {
            const ext = pattern.slice(1);
            if (base.endsWith(ext))
                return true;
        }
        // Prefix tilde: ~* or ~foo
        else if (pattern.startsWith("~")) {
            if (base.startsWith("~"))
                return true;
        }
        // Dot/hidden: .* or .foo
        else if (pattern.startsWith(".")) {
            if (base.startsWith("."))
                return true;
        }
        // Exact match
        else if (base === pattern) {
            return true;
        }
    }
    return false;
}
//# sourceMappingURL=watcher.js.map