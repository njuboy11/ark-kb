/**
 * Ark KB — Cohere Reranker Provider
 */
export async function cohereRerank(provider, query, documents) {
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
            top_n: documents.length,
            return_documents: false,
        }),
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Cohere reranker error (${response.status}): ${err}`);
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
//# sourceMappingURL=cohere.js.map