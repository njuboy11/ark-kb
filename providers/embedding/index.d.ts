/**
 * Ark KB — Embedding Router
 * Routes to the correct embedding provider based on URL-detected protocol.
 */
import type { ResolvedProvider } from "../config.js";
import type { EmbedResult } from "./openai.js";
import { openaiEmbed } from "./openai.js";
import { cohereEmbed } from "./cohere.js";
import { googleEmbed } from "./google.js";
export type { EmbedResult } from "./openai.js";
export declare function embed(provider: ResolvedProvider, texts: string[]): Promise<EmbedResult>;
export { openaiEmbed, cohereEmbed, googleEmbed };
//# sourceMappingURL=index.d.ts.map