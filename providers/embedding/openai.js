/**
 * Ark KB — OpenAI-compatible Embedding Provider
 * Covers: OpenAI, SiliconFlow, DashScope, DeepSeek, Ollama, vLLM, etc.
 */
export async function openaiEmbed(provider, texts) {
    const body = {
        model: provider.model.id,
        input: texts,
    };
    // Only send dimensions if the model supports it and user specified one
    if (provider.model.compat.supportsDimensions && provider.model.dimensions) {
        body.dimensions = provider.model.dimensions;
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
        throw new Error(`OpenAI embedding error (${response.status}): ${err}`);
    }
    const data = (await response.json());
    const vectors = data.data?.map((d) => d.embedding) ?? [];
    return {
        vectors,
        dimensions: vectors[0]?.length ?? 0,
        model: provider.model.id,
    };
}
//# sourceMappingURL=openai.js.map