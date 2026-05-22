/**
 * Ark KB — Main Entry
 * Wires together all components with nested config support.
 * Exports definePluginEntry-compatible register function for OpenClaw.
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
    private _initialized;
    constructor(rawConfig?: ArkKBConfig);
    init(): Promise<void>;
    private failedListPath;
    private retryFailed;
    private markFailed;
    search(query: string, options?: {
        topK?: number;
        rerankerEnabled?: boolean;
        rerankerMinScore?: number;
        resultCount?: number;
    }): Promise<any[]>;
    ingestFile(filePath: string): Promise<{
        entries: number;
        source: string;
        skipped: boolean;
    }>;
    removeSource(sourcePath: string): Promise<number>;
    status(): Promise<{
        chunkCount: number;
        sources: string[];
    }>;
    shutdown(): Promise<void>;
    get ingesterInstance(): Ingester;
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
/**
 * Creates the OpenClaw plugin definition.
 * Compatible with both TypeScript source and compiled JS output.
 */
export declare function createPlugin(ark: ArkKB): {
    id: string;
    name: string;
    description: string;
    tools: string[];
};
export declare function register(api: {
    registerTool: (tool: any, opts?: any) => void;
    registerRuntimeLifecycle: (lifecycle: {
        id: string;
        shutdown: () => Promise<void>;
    }) => void;
    config?: Record<string, any>;
    pluginConfig?: Record<string, any>;
}): void;
export interface IngesterConfig {
    chunking: ResolvedConfig["chunking"];
    pdfParser: ResolvedConfig["pdfParser"];
}
export interface SearcherConfig {
    search: ResolvedConfig["search"];
    reranker: ResolvedConfig["reranker"];
}
export interface WatcherConfig {
    enabled: boolean;
    paths: string[];
    debounceMs: number;
    ignorePatterns: string[];
}
//# sourceMappingURL=index.d.ts.map