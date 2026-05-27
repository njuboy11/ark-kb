/**
 * Ark KB — Provider Config Types & Loader
 * Pure JSON config, no presets, no dropdowns, no templates.
 */

export interface ModelCompat {
  supportsDimensions?: boolean;
  [key: string]: any;
}

export interface ModelConfig {
  id: string;
  name: string;
  dimensions?: number;
  compat: ModelCompat;
}

export interface ProviderConfig {
  url: string;
  apiKey: string;
  models: ModelConfig[];
}

export interface ProvidersConfig {
  providers: Record<string, ProviderConfig>;
}

// Resolved config for a single provider + model selection
export interface ResolvedProvider {
  providerName: string;
  url: string;
  apiKey: string;
  model: ModelConfig;
  modelId: string;
}

// ---- Default Config ----

const DEFAULT_CONFIG: ProvidersConfig = {
  providers: {},
};

// ---- Loader ----

let _config: ProvidersConfig | null = null;

/** Set provider config directly (called from main config resolution). */
export function setProviderConfig(raw: Record<string, any> | undefined): void {
  if (!raw?.providers) {
    _config = DEFAULT_CONFIG;
    return;
  }
  _config = { ...DEFAULT_CONFIG, ...raw };
}

export function getProviderConfig(): ProvidersConfig {
  return _config ?? DEFAULT_CONFIG;
}

export function getProvider(name: string): ProviderConfig | undefined {
  const cfg = resolveProviderWithModel(name);
  return cfg ? { url: cfg.url, apiKey: cfg.apiKey, models: [cfg.model] } : undefined;
}

export function resolveProviderWithModel(
  providerName: string,
  modelId?: string
): ResolvedProvider | undefined {
  const cfg = getProviderConfig();
  const p = cfg.providers[providerName];
  if (!p) return undefined;

  // If modelId specified, find it; otherwise use first model
  let model: ModelConfig | undefined;
  if (modelId) {
    model = p.models.find((m) => m.id === modelId);
  }
  if (!model) {
    model = p.models[0];
  }
  if (!model) return undefined;

  return {
    providerName,
    url: p.url,
    apiKey: p.apiKey,
    model,
    modelId: model.id,
  };
}

export function resolveProviderForModel(fullModelId: string): ResolvedProvider | undefined {
  // Format: "providerName/modelId" or just "providerName"
  const parts = fullModelId.split("/");
  if (parts.length === 2) {
    return resolveProviderWithModel(parts[0], parts[1]);
  }
  return resolveProviderWithModel(parts[0]);
}


