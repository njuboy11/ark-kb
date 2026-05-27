/**
 * Ark KB — Protocol Detector
 * Detect API protocol from URL. Default: openai.
 */
export function detectProtocol(url) {
    const u = url.toLowerCase();
    // Path-based detection (more specific first)
    if (u.includes("coding_plan/vlm"))
        return "minimax-vlm";
    if (u.includes("/anthropic"))
        return "anthropic";
    // Domain-based detection
    if (u.includes("cohere"))
        return "cohere";
    if (u.includes("mineru"))
        return "mineru";
    if (u.includes("anthropic.com"))
        return "anthropic";
    if (u.includes("googleapis") ||
        u.includes("generativelanguage"))
        return "google";
    // Default: OpenAI-compatible (covers 90%+ of providers)
    return "openai";
}
//# sourceMappingURL=detector.js.map