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
import { KBManager, KBInfo } from "./kb-manager.js";
import { ArkKBConfig, ResolvedConfig } from "./config.js";
export declare class ArkKB {
    config: ResolvedConfig;
    /** Primary multi-KB driver */
    kbManager: KBManager;
    /** Embedder instance (kept for per-KB Searcher construction) */
    embedder: Embedder;
    /** File watcher */
    watcher: FileWatcher;
    /** Email auto-ingester (null when disabled) */
    private emailIngester;
    /** Returns the default KB's KnowledgeStore (backward compat for tools) */
    get store(): KnowledgeStore;
    /** Returns a Searcher attached to the default KB store (backward compat for tools) */
    get searcher(): Searcher;
    /** Returns the default KB's Ingester (backward compat for tools) */
    get ingester(): Ingester;
    private _initialized;
    /** Searcher attached to the default KB (used when no specific kbName is given) */
    private _defaultSearcher;
    private _failedListPath;
    constructor(rawConfig?: ArkKBConfig);
    init(api?: any): Promise<void>;
    search(query: string, options?: {
        topK?: number;
        rerankerEnabled?: boolean;
        rerankerMinScore?: number;
        resultCount?: number;
        /** Target a specific KB; omit to search all KBs */
        kbName?: string;
    }): Promise<any[]>;
    /**
     * Apply a second-stage rerank across merged multi-KB results.
     * Falls back to returning the input if reranking fails.
     */
    private _globalRerank;
    ingestFile(filePath: string): Promise<import("./kb-manager.js").IngestResult>;
    removeSource(sourcePath: string, kbName?: string): Promise<number>;
    status(kbName?: string): Promise<{
        chunkCount: number;
        sources: string[];
        kbName?: string;
    }>;
    createKB(name: string): Promise<void>;
    deleteKB(name: string, confirm: boolean): Promise<{
        message?: string;
        requiresConfirm?: boolean;
        deleted?: boolean;
        kbName?: string;
    }>;
    listKBs(): Promise<KBInfo[]>;
    shutdown(): Promise<void>;
    get ingesterInstance(): Ingester;
    /**
     * Get the user\'s LLM config from the OpenClaw plugin API or openclaw.json.
     * Used by EmailIngester for KB routing decisions.
     */
    /** Auto-detect LLM from openclaw.json. Priority: defaultModel → first text model with apiKey (top-down). */
    private getUserLLM;
    private _initEmailIngester;
    private _retryFailed;
    private _markFailed;
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
                kb: {
                    type: string;
                    description: string;
                };
                filePath?: undefined;
                sourcePath?: undefined;
                name?: undefined;
                confirm?: undefined;
            };
            required: string[];
        };
        execute(_toolCallId: string, params: {
            query: string;
            count?: number;
            kb?: string;
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
                kb?: undefined;
                sourcePath?: undefined;
                name?: undefined;
                confirm?: undefined;
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
                kb: {
                    type: string;
                    description: string;
                };
                query?: undefined;
                count?: undefined;
                filePath?: undefined;
                name?: undefined;
                confirm?: undefined;
            };
            required: string[];
        };
        execute(_toolCallId: string, params: {
            sourcePath: string;
            kb?: string;
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
                kb: {
                    type: string;
                    description: string;
                };
                query?: undefined;
                count?: undefined;
                filePath?: undefined;
                sourcePath?: undefined;
                name?: undefined;
                confirm?: undefined;
            };
            required?: undefined;
        };
        execute(_toolCallId: string, params: {
            kb?: string;
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
                name: {
                    type: string;
                    description: string;
                };
                query?: undefined;
                count?: undefined;
                kb?: undefined;
                filePath?: undefined;
                sourcePath?: undefined;
                confirm?: undefined;
            };
            required: string[];
        };
        execute(_toolCallId: string, params: {
            name: string;
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
                name: {
                    type: string;
                    description: string;
                };
                confirm: {
                    type: string;
                    description: string;
                };
                query?: undefined;
                count?: undefined;
                kb?: undefined;
                filePath?: undefined;
                sourcePath?: undefined;
            };
            required: string[];
        };
        execute(_toolCallId: string, params: {
            name: string;
            confirm?: boolean;
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
                kb?: undefined;
                filePath?: undefined;
                sourcePath?: undefined;
                name?: undefined;
                confirm?: undefined;
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
    method: {
        image: "text" | "multimodal";
        video: "text" | "multimodal";
    };
}
export interface WatcherConfig {
    enabled: boolean;
    paths: string[];
    debounceMs: number;
    ignorePatterns: string[];
}
/** Re-export KBManager and KBInfo for consumers */
export { KBManager, KBInfo } from "./kb-manager.js";
export type { KBEntry, KBSearchResult, StoreOptions } from "./kb-manager.js";
//# sourceMappingURL=index.d.ts.map