/**
 * Ark KB — File Watcher
 * Recursively watches a directory for file changes and triggers re-indexing.
 */
import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
export class FileWatcher {
    watcher = null;
    handler = null;
    debounceTimers = new Map();
    fileSizes = new Map();
    watchPath = "";
    debounceMs = 2000;
    ignorePatterns = [];
    start(watchPath, handler, debounceMs = 2000, ignorePatterns = []) {
        this.watchPath = watchPath;
        this.handler = handler;
        this.debounceMs = debounceMs;
        this.ignorePatterns = ignorePatterns;
        this.watcher = watch(watchPath, { recursive: true }, async (event, filename) => {
            if (!filename || !this.handler)
                return;
            const filePath = `${watchPath}/${filename}`;
            if (shouldIgnore(basename(filename), this.ignorePatterns))
                return;
            if (event === "rename") {
                // "rename" fires for both new files and deleted files
                let exists = false;
                try {
                    const s = await stat(filePath);
                    exists = s.isFile();
                }
                catch {
                    exists = false;
                }
                if (exists) {
                    await this.debouncedHandle("add", filePath);
                }
                else {
                    await this.handler("unlink", filePath);
                }
            }
            else if (event === "change") {
                await this.debouncedHandle("change", filePath);
            }
        });
        console.log(`[Ark KB] File watcher started: ${watchPath}`);
    }
    async debouncedHandle(event, filePath) {
        // Cancel any pending timer for this file
        const existing = this.debounceTimers.get(filePath);
        if (existing !== undefined) {
            clearTimeout(existing);
            this.debounceTimers.delete(filePath);
        }
        // If file exists and this is an add/change, wait for write to stabilize
        if (event === "add" || event === "change") {
            try {
                const s = await stat(filePath);
                const prevSize = this.fileSizes.get(filePath) ?? -1;
                this.fileSizes.set(filePath, s.size);
                if (prevSize === s.size && s.size > 0) {
                    // File size hasn't changed — content is stable, trigger now
                    this.debounceTimers.delete(filePath);
                    await this.handler("change", filePath);
                    return;
                }
            }
            catch {
                // File no longer exists
                this.debounceTimers.delete(filePath);
                return;
            }
        }
        // Set a new debounce timer
        const timer = setTimeout(async () => {
            this.debounceTimers.delete(filePath);
            // Final existence check
            try {
                await stat(filePath);
            }
            catch {
                return; // File was deleted before timer fired
            }
            await this.handler(event, filePath);
        }, this.debounceMs);
        this.debounceTimers.set(filePath, timer);
    }
    stop() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.fileSizes.clear();
        console.log("[Ark KB] File watcher stopped");
    }
}
/**
 * Check if a filename matches any of the given ignore patterns.
 * Supports glob-style patterns: *.tmp, ~*, .*, etc.
 */
function shouldIgnore(filename, patterns) {
    const base = basename(filename);
    for (const pattern of patterns) {
        if (pattern.startsWith("*.") && base.endsWith(pattern.slice(1)))
            return true;
        if (pattern.endsWith("*") && base.startsWith(pattern.slice(0, -1)))
            return true;
        if (pattern.startsWith(".") && base.startsWith("."))
            return true;
        if (base === pattern)
            return true;
    }
    return false;
}
//# sourceMappingURL=watcher.js.map