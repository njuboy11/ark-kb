/**
 * Ark KB — Provider Config Types & Loader
 * Pure JSON config, no presets, no dropdowns, no templates.
 */
// ---- Default Config ----
const DEFAULT_CONFIG = {
    providers: {},
};
// ---- Loader ----
let _config = null;
/** Set provider config directly (called from main config resolution). */
export function setProviderConfig(raw) {
    if (!raw?.providers) {
        _config = DEFAULT_CONFIG;
        return;
    }
    _config = { ...DEFAULT_CONFIG, ...raw };
}
export function getProviderConfig() {
    return _config ?? DEFAULT_CONFIG;
}
export function getProvider(name) {
    const cfg = resolveProviderWithModel(name);
    return cfg ? { url: cfg.url, apiKey: cfg.apiKey, models: [cfg.model] } : undefined;
}
export function resolveProviderWithModel(providerName, modelId) {
    const cfg = getProviderConfig();
    const p = cfg.providers[providerName];
    if (!p)
        return undefined;
    // If modelId specified, find it; otherwise use first model
    let model;
    if (modelId) {
        model = p.models.find((m) => m.id === modelId);
    }
    if (!model) {
        model = p.models[0];
    }
    if (!model)
        return undefined;
    return {
        providerName,
        url: p.url,
        apiKey: p.apiKey,
        model,
        modelId: model.id,
    };
}
export function resolveProviderForModel(fullModelId) {
    // Format: "providerName/modelId" or just "providerName"
    const parts = fullModelId.split("/");
    if (parts.length === 2) {
        return resolveProviderWithModel(parts[0], parts[1]);
    }
    return resolveProviderWithModel(parts[0]);
}
//# sourceMappingURL=config.js.map