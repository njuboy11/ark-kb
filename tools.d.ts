/**
 * Ark KB — Tool Registration
 * 向 OpenClaw 注册 kb_search / kb_ingest / kb_remove / kb_status 等工具
 */
import { ArkKB } from "./index.js";
/**
 * 注册 ark-kb 工具到 OpenClaw
 */
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
            text: any;
        }[];
        data: {
            results: any;
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