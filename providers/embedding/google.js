/**
 * Ark KB — Google (Gemini) Embedding Provider
 */
export async function googleEmbed(provider, texts) {
    const model = provider.model.id.startsWith("models/")
        ? provider.model.id
        : `models/${provider.model.id}`;
    // Google batch embedding
    const baseUrl = provider.url.replace(/\/$/, "");
    const response = await fetch(provider.url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(provider.apiKey
                ? { "x-goog-api-key": provider.apiKey }
                : {}),
        },
        body: JSON.stringify({
            requests: texts.map((t) => ({
                model,
                content: { parts: [{ text: t }] },
            })),
        }),
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Google embedding error (${response.status}): ${err}`);
    }
    const data = (await response.json());
    const vectors = [];
    if (data.embeddings) {
        for (const emb of data.embeddings) {
            vectors.push(emb.values ?? []);
        }
    }
    // Google doesn't support custom dimensions — always returns fixed size
    return {
        vectors,
        dimensions: vectors[0]?.length ?? 0,
        model: provider.model.id,
    };
}
//# sourceMappingURL=google.js.map