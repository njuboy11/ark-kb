/**
 * Ark KB — Email Ingester
 * Monitors an IMAP mailbox and auto-ingests email attachments into knowledge bases.
 */
import { KBManager } from "./kb-manager.js";
export interface EmailIngesterConfig {
    enabled: boolean;
    host: string;
    port: number;
    tls: boolean;
    user: string;
    password: string;
    scanIntervalMs: number;
    maxRetries: number;
}
export interface EmailState {
    lastProcessedTime: string;
    lastScan: number;
    totalProcessed: number;
    lastProcessedUID: number;
    failed: Array<{
        uid: number;
        messageId: string;
        error: string;
        retries: number;
        arrivedAt: string;
    }>;
}
interface AttachmentInfo {
    filename: string;
    mimeType: string;
    data: Buffer;
}
export declare class EmailIngester {
    private config;
    private kbManager;
    private knowledgePath;
    private llmClient;
    private emailStatePath;
    private state;
    private scanTimer;
    private imapClient;
    private ImapFlow;
    private _scanning;
    constructor(opts: {
        config: EmailIngesterConfig;
        kbManager: KBManager;
        knowledgePath: string;
        llmClient: {
            endpoint: string;
            apiKey: string;
            model: string;
        };
    });
    init(): Promise<void>;
    scan(): Promise<void>;
    private _processEmail;
    /**
     * Route an email to the appropriate KB(s).
     * Stage 0: Regex match KB names in subject+body.
     * Stage 1: LLM analyzes subject+body to pick KB(s).
     * Stage 2: If stage 1 returns "none", analyze attachment content.
     */
    routeEmail(subject: string, body: string, attachments: AttachmentInfo[], kbNames: string[]): Promise<string[]>;
    private _routeAttachment;
    askLLM(systemPrompt: string, userContent: string): Promise<string>;
    askVLM(systemPrompt: string, imageBase64: string, mimeType?: string): Promise<string>;
    private _parseLLMJson;
    private _connect;
    private _parseEmail;
    private _loadState;
    private _saveState;
    private _recordFailure;
    shutdown(): Promise<void>;
    private _sleep;
    private _mimeType;
    /** Get current state for status reporting */
    getState(): EmailState;
}
export {};
//# sourceMappingURL=email-ingester.d.ts.map