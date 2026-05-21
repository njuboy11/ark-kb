/**
 * Ark KB — Tool Registration
 * Registers kb_search, kb_ingest, kb_remove, kb_status tools.
 */
import { ArkKB } from "./index.js";
export declare function registerKBTools(ark: ArkKB): ({
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
//# sourceMappingURL=tools.d.ts.map