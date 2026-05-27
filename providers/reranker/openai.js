/**
 * Ark KB — OpenAI-compatible Reranker Provider
 * Covers: SiliconFlow, DashScope, Jina, etc.
 */
export async function openaiRerank(provider, query, documents) {
    const response = await fetch(provider.url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${provider.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: provider.model.id,
            query,
            documents,
            return_documents: false,
        }),
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI reranker error (${response.status}): ${err}`);
    }
    const data = (await response.json());
    if (data.results && Array.isArray(data.results)) {
        return data.results.map((r) => ({
            index: r.index,
            score: r.relevance_score ?? r.score ?? 0,
        }));
    }
    return [];
}
//# sourceMappingURL=openai.js.map