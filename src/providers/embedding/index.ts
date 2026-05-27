/**
 * Ark KB — Embedding Router
 * Routes to the correct embedding provider based on URL-detected protocol.
 */

import { detectProtocol } from "../detector.js";
import type { ResolvedProvider } from "../config.js";
import type { EmbedResult } from "./openai.js";
import { openaiEmbed } from "./openai.js";
import { cohereEmbed } from "./cohere.js";
import { googleEmbed } from "./google.js";

export type { EmbedResult } from "./openai.js";

export async function embed(
  provider: ResolvedProvider,
  texts: string[]
): Promise<EmbedResult> {
  const protocol = detectProtocol(provider.url);

  switch (protocol) {
    case "cohere":
      return cohereEmbed(provider, texts);
    case "google":
      return googleEmbed(provider, texts);
    case "openai":
    default:
      return openaiEmbed(provider, texts);
  }
}

export { openaiEmbed, cohereEmbed, googleEmbed };
