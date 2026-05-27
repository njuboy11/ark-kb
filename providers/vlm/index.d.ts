/**
 * Ark KB — VLM Providers (OpenAI / Anthropic / MiniMax)
 */
import type { ResolvedProvider } from "../config.js";
export interface VLMResult {
    text: string;
    tokensUsed?: number;
}
export declare function openaiVLM(provider: ResolvedProvider, imageBase64: string, prompt: string, mimeType?: string): Promise<VLMResult>;
export declare function anthropicVLM(provider: ResolvedProvider, imageBase64: string, prompt: string, mimeType?: string): Promise<VLMResult>;
export declare function minimaxVLM(provider: ResolvedProvider, imageBase64: string, prompt: string, mimeType?: string): Promise<VLMResult>;
//# sourceMappingURL=index.d.ts.map