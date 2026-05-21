/**
 * Ark KB — File Watcher
 * 文件系统监听：新增/修改/删除自动触发索引更新
 */

import { watch, FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, basename } from "node:path";

export type FileEvent = "add" | "change" | "unlink";

export type FileEventHandler = (
  event: FileEvent,
  filePath: string,
) => Promise<void>;

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private handler: FileEventHandler | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private fileSizes = new Map<string, number>();
  private watchPath: string = "";

  start(watchPath: string, handler: FileEventHandler): void {
    this.watchPath = watchPath;
    this.handler = handler;

    this.watcher = watch(watchPath, { recursive: true }, async (event, filename) => {
      if (!filename) return;
      const filePath = `${watchPath}/${filename}`;

      // 忽略隐藏文件、临时文件、目录
      if (shouldIgnore(filename)) return;

      if (event === "rename") {
        // rename 可能是新建或删除
        let exists = false;
        try {
          const s = await stat(filePath);
          exists = s.isFile();
        } catch {
          exists = false;
        }

        if (exists) {
          // 新文件到达（或重命名进来的文件）
          await this.debounce("add", filePath, handler);
        } else {
          // 文件被删除
          await handler("unlink", filePath);
        }
      } else if (event === "change") {
        // 文件内容变更
        await this.debounce("change", filePath, handler);
      }
    });

    console.log(`[Ark KB] 文件监听已启动: ${watchPath}`);
  }

  private async debounce(
    event: FileEvent,
    filePath: string,
    handler: FileEventHandler,
  ): Promise<void> {
    // 清除上一次的定时器
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    // 如果是 change 事件，检查文件是否写完
    if (event === "change" || event === "add") {
      try {
        const s = await stat(filePath);
        const prevSize = this.fileSizes.get(filePath) ?? -1;
        if (prevSize === s.size && s.size > 0) {
          // 文件尺寸稳定了，直接触发
          this.debounceTimers.delete(filePath);
          await handler(event, filePath);
          return;
        }
        this.fileSizes.set(filePath, s.size);
      } catch {
        // 文件可能已被删除
        this.debounceTimers.delete(filePath);
        return;
      }
    }

    // 等 2 秒再看是否稳定
    const timer = setTimeout(async () => {
      this.debounceTimers.delete(filePath);

      // 最终确认文件仍然存在
      try {
        await stat(filePath);
      } catch {
        return; // 文件已不在了
      }

      await handler(event, filePath);
    }, 2000);

    this.debounceTimers.set(filePath, timer);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.fileSizes.clear();
    console.log("[Ark KB] 文件监听已停止");
  }
}

function shouldIgnore(filename: string): boolean {
  const base = basename(filename);
  // 忽略隐藏文件、临时文件、Office 临时文件
  if (base.startsWith(".")) return true;
  if (base.startsWith("~")) return true;
  if (base.endsWith(".tmp")) return true;
  if (base.endsWith(".swp")) return true;
  if (base.endsWith(".part")) return true;
  return false;
}
