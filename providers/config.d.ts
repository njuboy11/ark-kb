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
export interface ResolvedProvider {
    providerName: string;
    url: string;
    apiKey: string;
    model: ModelConfig;
    modelId: string;
}
/** Set provider config directly (called from main config resolution). */
export declare function setProviderConfig(raw: Record<string, any> | undefined): void;
export declare function getProviderConfig(): ProvidersConfig;
export declare function getProvider(name: string): ProviderConfig | undefined;
export declare function resolveProviderWithModel(providerName: string, modelId?: string): ResolvedProvider | undefined;
export declare function resolveProviderForModel(fullModelId: string): ResolvedProvider | undefined;
//# sourceMappingURL=config.d.ts.map