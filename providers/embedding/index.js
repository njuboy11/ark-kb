/**
 * Ark KB — Embedding Router
 * Routes to the correct embedding provider based on URL-detected protocol.
 */
import { detectProtocol } from "../detector.js";
import { openaiEmbed } from "./openai.js";
import { cohereEmbed } from "./cohere.js";
import { googleEmbed } from "./google.js";
export async function embed(provider, texts) {
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
//# sourceMappingURL=index.js.map