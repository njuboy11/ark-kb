/**
 * Ark KB — File Watcher
 * Recursively watches a directory for file changes and triggers re-indexing.
 */
export type FileEvent = "add" | "change" | "unlink";
export type FileEventHandler = (event: FileEvent, filePath: string) => Promise<void>;
export declare class FileWatcher {
    private watcher;
    private handler;
    private debounceTimers;
    private fileSizes;
    private watchPath;
    private debounceMs;
    private ignorePatterns;
    start(watchPath: string, handler: FileEventHandler, debounceMs?: number, ignorePatterns?: string[]): void;
    private debouncedHandle;
    stop(): void;
}
//# sourceMappingURL=watcher.d.ts.map