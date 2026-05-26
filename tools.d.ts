/**
 * Ark KB — Tool Registration
 * Registers kb_search, kb_ingest, kb_remove, kb_status,
 * kb_create, kb_delete, kb_list tools with OpenClaw.
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
            };
            kb: {
                type: string;
                description: string;
            };
            fileType: {
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
        fileType?: string;
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
            fileType?: undefined;
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
            fileType?: undefined;
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
            fileType?: undefined;
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
            fileType?: undefined;
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
            fileType?: undefined;
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
            fileType?: undefined;
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
//# sourceMappingURL=tools.d.ts.map