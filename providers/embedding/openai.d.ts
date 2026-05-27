/**
 * Ark KB — OpenAI-compatible Embedding Provider
 * Covers: OpenAI, SiliconFlow, DashScope, DeepSeek, Ollama, vLLM, etc.
 */
import type { ResolvedProvider } from "../config.js";
export interface EmbedResult {
    vectors: number[][];
    dimensions: number;
    model: string;
}
export declare function openaiEmbed(provider: ResolvedProvider, texts: string[]): Promise<EmbedResult>;
//# sourceMappingURL=openai.d.ts.map