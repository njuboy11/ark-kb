/**
 * Ark KB — Providers
 * Unified multi-provider abstraction layer.
 */

// Config
export {
  setProviderConfig,
  getProviderConfig,
  getProvider,
  resolveProviderWithModel,
  resolveProviderForModel,
  type ProvidersConfig,
  type ProviderConfig,
  type ModelConfig,
  type ModelCompat,
  type ResolvedProvider,
} from "./config.js";

// Detector
export { detectProtocol, type ProtocolId } from "./detector.js";

// Embedding
export {
  embed,
  openaiEmbed,
  cohereEmbed,
  googleEmbed,
  type EmbedResult,
} from "./embedding/index.js";

// Reranker
export {
  rerank,
  openaiRerank,
  cohereRerank,
  type RerankResult,
} from "./reranker/index.js";

// VLM
export {
  openaiVLM,
  anthropicVLM,
  minimaxVLM,
  type VLMResult,
} from "./vlm/index.js";

// PDF
export { mineruParse, type PDFParseResult } from "./pdf/mineru.js";
