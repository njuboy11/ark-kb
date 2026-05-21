/**
 * Ark KB — File Watcher
 * 文件系统监听：新增/修改/删除自动触发索引更新
 */
export type FileEvent = "add" | "change" | "unlink";
export type FileEventHandler = (event: FileEvent, filePath: string) => Promise<void>;
export declare class FileWatcher {
    private watcher;
    private handler;
    private debounceTimers;
    private fileSizes;
    private watchPath;
    start(watchPath: string, handler: FileEventHandler): void;
    private debounce;
    stop(): void;
}
//# sourceMappingURL=watcher.d.ts.map