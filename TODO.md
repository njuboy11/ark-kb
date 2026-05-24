# ark-kb 待修复项

> 最后更新：2026-05-24 四轮审查后

## 需重构（不影响当前单 KB 使用）

### B2 montage glob 展开
- **文件**: `src/video.ts` extractAndTile
- **问题**: `spawn("montage", ["frame_*.jpg"])`，glob `*` 不加 `shell:true` 时是普通字符串，montage 拿不到文件列表
- **修复**: Node 侧 `readdirSync` 展开 glob → 绝对路径数组 → 传给 spawn

### B3 多 KB 隔离（kb_ingest 工具）
- **文件**: `src/tools.ts` + `src/kb-manager.ts`
- **问题**: `kb_ingest` 调默认 KB 的 `ingestDirectory(knowledgePath)`，遍历整个根目录 → 所有 KB 子目录文件被吞进默认 KB
- **修复**: 遍历每个 KB 分别 `heal()`

### TOCTOU 竞态
- **文件**: `src/ingester.ts` ingestFile
- **问题**: `hasFileHash` 检查和 `insert` 之间存在竞态窗口
- **修复**: 使用 LanceDB upsert 或 per-file mutex

### 非原子写入
- **文件**: `src/ingester.ts` ingestFile
- **问题**: `deleteBySource` → `insert` 不是原子操作，中间 crash 丢数据
- **修复**: 先 insert 再 delete（幂等）

### PDF MinerU 配置传递（已部分修复）
- **文件**: `src/kb-manager.ts` _makeIngester
- **问题**: 已改为 `(this.embedderConfig as any).pdfParser`，不是干净的类型安全方案
- **修复**: 在 `MultiKBOptions` 接口中正式加 `pdfParser` 字段

### heal() 去重逻辑
- **文件**: `src/ingester.ts` heal
- **问题**: `searchBM25(base, 1)` 按文件名搜文本不精确，已存文件重复摄入
- **修复**: 用 `hasFileHash` 做 O(1) 哈希去重
