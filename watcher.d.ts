/**
 * Ark KB — File Watcher
 * Monitors one or more directories for file changes and triggers re-indexing.
 * Configurable debounce, file stability check, and ignore patterns.
 */
import { WatcherConfig } from "./index.js";
export type FileEvent = "add" | "change" | "unlink";
export type FileEventHandler = (event: FileEvent, filePath: string) => Promise<void>;
export declare class FileWatcher {
    private watchers;
    private handler;
    private debounceTimers;
    private fileSizes;
    private config;
    constructor(config?: Partial<WatcherConfig>);
    /**
     * Start watching the primary knowledge path and any additional configured paths.
     */
    start(knowledgePath: string, handler: FileEventHandler): void;
    private watchPath;
    /**
     * Debounce events: wait for file size to stabilize before triggering.
     * This prevents re-indexing a file that is still being written.
     */
    private debouncedDispatch;
    private safeHandler;
    /**
     * Stop all watchers and clear timers.
     */
    stop(): void;
}
//# sourceMappingURL=watcher.d.ts.map