/**
 * Ark KB — Main Entry
 * Initializes and wires together Store, Embedder, Ingester, Searcher, and Watcher.
 */
import { KnowledgeStore } from "./store.js";
import { Embedder } from "./embedder.js";
import { Ingester } from "./ingester.js";
import { Searcher } from "./searcher.js";
import { FileWatcher } from "./watcher.js";
import { ArkKBConfig, ResolvedConfig } from "./config.js";
export declare class ArkKB {
    store: KnowledgeStore;
    embedder: Embedder;
    ingester: Ingester;
    searcher: Searcher;
    watcher: FileWatcher;
    config: ResolvedConfig;
    private initialized;
    constructor(config: ArkKBConfig);
    init(): Promise<void>;
    search(query: string, options?: Partial<import("./searcher.js").SearchOptions>): Promise<import("./searcher.js").SearchResult[]>;
    ingestFile(filePath: string): Promise<{
        entries: number;
        source: string;
    }>;
    ingestDirectory(): Promise<{
        total: number;
        files: number;
    }>;
    removeSource(sourcePath: string): Promise<number>;
    status(): Promise<{
        chunkCount: number;
        sources: string[];
    }>;
    shutdown(): Promise<void>;
    /**
     * Returns the tool registration array for OpenClaw.
     */
    getTools(): ({
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                query: {
                    type: string;
                    description: string;
                };
                count: {
                    type: string;
                    description: string;
                    default: number;
                };
                filePath?: undefined;
                sourcePath?: undefined;
            };
            required: string[];
        };
        execute(_toolCallId: string, params: {
            query: string;
            count?: number;
        }): Promise<{
            content: {
                type: "text";
                text: string;
            }[];
            data?: undefined;
        } | {
            content: {
                type: "text";
                text: string;
            }[];
            data: {
                results: {
                    score: any;
                    chunk_text: any;
                    source_path: any;
                    chunk_index: any;
                    total_chunks: any;
                    images: any;
                    file_type: any;
                }[];
            };
        }>;
    } | {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                filePath: {
                    type: string;
                    description: string;
                };
                query?: undefined;
                count?: undefined;
                sourcePath?: undefined;
            };
            required?: undefined;
        };
        execute(_toolCallId: string, params: {
            filePath?: string;
        }): Promise<{
            content: {
                type: "text";
                text: string;
            }[];
        }>;
    } | {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                sourcePath: {
                    type: string;
                    description: string;
                };
                query?: undefined;
                count?: undefined;
                filePath?: undefined;
            };
            required: string[];
        };
        execute(_toolCallId: string, params: {
            sourcePath: string;
        }): Promise<{
            content: {
                type: "text";
                text: string;
            }[];
        }>;
    } | {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                query?: undefined;
                count?: undefined;
                filePath?: undefined;
                sourcePath?: undefined;
            };
            required?: undefined;
        };
        execute(): Promise<{
            content: {
                type: "text";
                text: string;
            }[];
        }>;
    })[];
}
export type { ArkKBConfig, ResolvedConfig } from "./config.js";
export type { SearchOptions, SearchResult, SourceContent } from "./searcher.js";
//# sourceMappingURL=index.d.ts.map