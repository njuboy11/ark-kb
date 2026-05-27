/**
 * Ark KB — Reranker Router
 */
import { detectProtocol } from "../detector.js";
import { openaiRerank } from "./openai.js";
import { cohereRerank } from "./cohere.js";
export async function rerank(provider, query, documents) {
    const protocol = detectProtocol(provider.url);
    switch (protocol) {
        case "cohere":
            return cohereRerank(provider, query, documents);
        case "openai":
        default:
            return openaiRerank(provider, query, documents);
    }
}
export { openaiRerank, cohereRerank };
//# sourceMappingURL=index.js.map