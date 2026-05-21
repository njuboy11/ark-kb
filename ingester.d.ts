/**
 * Ark KB — Ingester
 * 文件读取、分块、向量化、索引写入
 */
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
export declare class Ingester {
    private store;
    private embedder;
    constructor(store: KnowledgeStore, embedder: Embedder);
    ingestFile(filePath: string): Promise<{
        entries: number;
        source: string;
    }>;
    ingestDirectory(dirPath: string): Promise<{
        total: number;
        files: number;
    }>;
}
//# sourceMappingURL=ingester.d.ts.map