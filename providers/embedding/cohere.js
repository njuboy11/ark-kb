/**
 * Ark KB — Cohere Embedding Provider
 */
export async function cohereEmbed(provider, texts) {
    const body = {
        model: provider.model.id,
        texts,
        input_type: "search_document",
        embedding_types: ["float"],
    };
    // Cohere uses output_dimension instead of dimensions
    if (provider.model.compat.supportsDimensions && provider.model.dimensions) {
        body.output_dimension = provider.model.dimensions;
    }
    const response = await fetch(provider.url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${provider.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Cohere embedding error (${response.status}): ${err}`);
    }
    const data = (await response.json());
    const vectors = (data.embeddings?.float ?? data.embeddings ?? []);
    return {
        vectors,
        dimensions: vectors[0]?.length ?? 0,
        model: provider.model.id,
    };
}
//# sourceMappingURL=cohere.js.map