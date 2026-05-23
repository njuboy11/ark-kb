/**
 * Ark KB — Configuration Types
 */

import { existsSync, readFileSync } from "node:fs";
import { resolveEmbeddingBatchSize, resolveEmbeddingDimensions, resolveEmbeddingEndpoint, resolveEmbeddingModalities, resolveRerankerCapabilities } from "./embedder.js";

// ============================================================================
// Top-level config (what users set under plugins.entries["@njuboy11/ark-kb"].config)
// ============================================================================

export interface ArkKBConfig {
  knowledgePath?: string;
  storage?: {
    dbPath?: string;
  };
  embedding?: {
    endpoint?: string;
    apiKey?: string;
    model?: string;
    dimensions?: number;
    /** Embedding method per modality. "text" = VLM summary → text embedding. "multimodal" = direct multimodal embedding. */
    method?: {
      image?: "text" | "multimodal";
      video?: "text" | "multimodal";
    };
  };
  reranker?: {
    /** Set to false to disable reranking entirely */
    enabled?: boolean;
    endpoint?: string;
    apiKey?: string;
    model?: string;
    minScore?: number;
    multimodal?: {
      endpoint?: string;
      apiKey?: string;
      model?: string;
    };
  };
  pdfParser?: {
    endpoint?: string;
    apiKey?: string;
    model?: string;
    params?: Record<string, any>;
  };
  search?: {
    vectorWeight?: number;
    topK?: number;
    resultCount?: number;
    bm25Enabled?: boolean;
    fusionMethod?: "min_max" | "z_score" | "rrf" | "raw";
  };
  chunking?: {
    maxTokens?: number;
    overlapTokens?: number;
    strategy?: "paragraph" | "fixed" | "sentence";
  };
  watcher?: {
    enabled?: boolean;
    paths?: string[];
    debounceMs?: number;
    ignorePatterns?: string[];
  };
  /** Video summarization via VLM (e.g. MiniMax /v1/coding_plan/vlm) */
  videoSummarizer?: {
    enabled?: boolean;
    provider?: string;
    endpoint?: string;
    apiKey?: string;
    /** Max frames to send to VLM (default 100) */
    maxFrames?: number;
  };
  /** Image summarizer config (used when embedding.method.image = "text"). Defaults to videoSummarizer values. */
  imageSummarizer?: {
    enabled?: boolean;
    endpoint?: string;
    apiKey?: string;
  };
}

// ============================================================================
// Resolved config (fully populated with defaults)
// ============================================================================

export interface ResolvedConfig {
  knowledgePath: string;
  storage: {
    dbPath: string;
  };
  embedding: {
    api: "dashscope" | "siliconflow" | "openai" | "custom";
    endpoint: string;
    apiKey: string;
    model: string;
    dimensions: number;
    batchSize: number;
    method: {
      image: "text" | "multimodal";
      video: "text" | "multimodal";
    };
  };
  reranker: {
    enabled: boolean;
    api: "siliconflow" | "cohere" | "custom" | "none";
    endpoint: string;
    apiKey: string;
    model: string;
    minScore: number;
    multimodal?: {
      endpoint?: string;
      apiKey?: string;
      model?: string;
    };
  };
  pdfParser: {
    api: "mineru" | "builtin" | "none";
    endpoint: string;
    apiKey: string;
    model: string;
    params: Record<string, any>;
  };
  search: {
    vectorWeight: number;
    topK: number;
    resultCount: number;
    bm25Enabled: boolean;
    fusionMethod: "min_max" | "z_score" | "rrf" | "raw";
  };
  chunking: {
    maxTokens: number;
    overlapTokens: number;
    strategy: "paragraph" | "fixed" | "sentence";
  };
  watcher: {
    enabled: boolean;
    paths: string[];
    debounceMs: number;
    ignorePatterns: string[];
  };
  videoSummarizer: {
    enabled: boolean;
    endpoint: string;
    apiKey: string;
    maxFrames: number;
  };
  imageSummarizer: {
    enabled: boolean;
    endpoint: string;
    apiKey: string;
  };
}

export const DEFAULTS: Omit<ResolvedConfig, "knowledgePath"> = {
  storage: {
    dbPath: "~/.ark-kb/lancedb",
  },
  embedding: {
    api: "siliconflow",
    endpoint: "https://api.siliconflow.cn/v1/embeddings",
    apiKey: "",
    model: "Qwen/Qwen3-VL-Embedding-8B",
    dimensions: 4096,
    batchSize: 16,
    method: { image: "text" as const, video: "text" as const },
  },
  reranker: {
    enabled: true,
    api: "none",
    endpoint: "https://api.siliconflow.cn/v1/rerank",
    apiKey: "",
    model: "BAAI/bge-reranker-v2-m3",
    minScore: 0.35,
  },
  pdfParser: {
    api: "none",
    endpoint: "",
    apiKey: "",
    model: "precise-v4",
    params: {},
  },
  search: {
    vectorWeight: 1.0,
    topK: 20,
    resultCount: 6,
    bm25Enabled: true,
    fusionMethod: "min_max",
  },
  chunking: {
    maxTokens: 400,
    overlapTokens: 50,
    strategy: "paragraph",
  },
  watcher: {
    enabled: true,
    paths: [],
    debounceMs: 2000,
    ignorePatterns: [".*", "~*", "*.tmp", "*.swp", "*.part"],
  },
  videoSummarizer: {
    enabled: false,
    endpoint: "https://api.minimaxi.com/v1/coding_plan/vlm",
    apiKey: "",
    maxFrames: 100,
  },
  imageSummarizer: {
    enabled: false,
    endpoint: "https://api.minimaxi.com/v1/coding_plan/vlm",
    apiKey: "",
  },
};

// ============================================================================
// Auto-detect API protocol from endpoint URL
// ============================================================================

function detectEmbeddingApi(endpoint: string): "dashscope" | "siliconflow" | "openai" | "custom" {
  const u = endpoint.toLowerCase();
  if (u.includes("siliconflow")) return "siliconflow";
  if (u.includes("dashscope") || u.includes("aliyun")) return "dashscope";
  if (u.includes("openai")) return "openai";
  return "custom";
}

function detectRerankerApi(endpoint: string, apiKey: string): "siliconflow" | "cohere" | "custom" | "none" {
  if (!apiKey) return "none";
  const u = endpoint.toLowerCase();
  if (u.includes("siliconflow")) return "siliconflow";
  if (u.includes("cohere")) return "cohere";
  return "custom";
}

function detectPdfParserApi(endpoint: string, apiKey: string): "mineru" | "builtin" | "none" {
  if (!apiKey) return "none";
  const u = endpoint.toLowerCase();
  if (u.includes("mineru")) return "mineru";
  return "builtin";
}

// ============================================================================
// Config validation (for standalone config file)
// ============================================================================

export function validateConfig(raw: unknown): string[] {
  const errors: string[] = [];
  if (raw === null || raw === undefined || typeof raw !== "object") {
    errors.push("Config must be a JSON object");
    return errors;
  }
  const c = raw as Record<string, unknown>;

  // knowledgePath
  if (c.knowledgePath !== undefined && typeof c.knowledgePath !== "string") {
    errors.push("knowledgePath must be a string");
  }

  for (const section of ["storage", "embedding", "reranker", "pdfParser", "search", "chunking", "watcher", "videoSummarizer", "imageSummarizer"]) {
    if (c[section] !== undefined && (typeof c[section] !== "object" || c[section] === null)) {
      errors.push(`${section} must be an object`);
    }
  }

  if (c.storage) {
    const s = c.storage as Record<string, unknown>;
    if (s.dbPath !== undefined && typeof s.dbPath !== "string") {
      errors.push("storage.dbPath must be a string");
    }
  }

  if (c.embedding) {
    const e = c.embedding as Record<string, unknown>;
    if (e.apiKey !== undefined && typeof e.apiKey !== "string") {
      errors.push("embedding.apiKey must be a string");
    }
    if (e.model !== undefined && typeof e.model !== "string") {
      errors.push("embedding.model must be a string");
    }
    if (e.endpoint !== undefined && typeof e.endpoint !== "string") {
      errors.push("embedding.endpoint must be a string");
    }
    if (e.dimensions !== undefined && typeof e.dimensions !== "number") {
      errors.push("embedding.dimensions must be a number");
    }
    if (e.method !== undefined && typeof e.method !== "object") {
      errors.push("embedding.method must be an object");
    }
    if (e.method) {
      const m = e.method as Record<string, unknown>;
      if (m.image !== undefined && !["text", "multimodal"].includes(m.image as string)) {
        errors.push("embedding.method.image must be 'text' or 'multimodal'");
      }
      if (m.video !== undefined && !["text", "multimodal"].includes(m.video as string)) {
        errors.push("embedding.method.video must be 'text' or 'multimodal'");
      }
    }
  }

  if (c.reranker) {
    const r = c.reranker as Record<string, unknown>;
    if (r.enabled !== undefined && typeof r.enabled !== "boolean") {
      errors.push("reranker.enabled must be a boolean");
    }
    if (r.apiKey !== undefined && typeof r.apiKey !== "string") {
      errors.push("reranker.apiKey must be a string");
    }
    if (r.model !== undefined && typeof r.model !== "string") {
      errors.push("reranker.model must be a string");
    }
    if (r.endpoint !== undefined && typeof r.endpoint !== "string") {
      errors.push("reranker.endpoint must be a string");
    }
    if (r.minScore !== undefined && typeof r.minScore !== "number") {
      errors.push("reranker.minScore must be a number");
    }
  }

  if (c.search) {
    const s = c.search as Record<string, unknown>;
    if (s.vectorWeight !== undefined && typeof s.vectorWeight !== "number") {
      errors.push("search.vectorWeight must be a number");
    }
    if (s.topK !== undefined && typeof s.topK !== "number") {
      errors.push("search.topK must be a number");
    }
    if (s.resultCount !== undefined && typeof s.resultCount !== "number") {
      errors.push("search.resultCount must be a number");
    }
    if (s.bm25Enabled !== undefined && typeof s.bm25Enabled !== "boolean") {
      errors.push("search.bm25Enabled must be a boolean");
    }
  }

  if (c.chunking) {
    const ch = c.chunking as Record<string, unknown>;
    if (ch.maxTokens !== undefined && typeof ch.maxTokens !== "number") {
      errors.push("chunking.maxTokens must be a number");
    }
    if (ch.overlapTokens !== undefined && typeof ch.overlapTokens !== "number") {
      errors.push("chunking.overlapTokens must be a number");
    }
    if (ch.strategy !== undefined && !["paragraph", "fixed", "sentence"].includes(ch.strategy as string)) {
      errors.push(`chunking.strategy must be one of: paragraph, fixed, sentence (got: ${ch.strategy})`);
    }
  }

  if (c.watcher) {
    const w = c.watcher as Record<string, unknown>;
    if (w.enabled !== undefined && typeof w.enabled !== "boolean") {
      errors.push("watcher.enabled must be a boolean");
    }
    if (w.debounceMs !== undefined && typeof w.debounceMs !== "number") {
      errors.push("watcher.debounceMs must be a number");
    }
  }

  // ── Cross-field validation ────────────────────────────────
  const e = c.embedding as Record<string, unknown> | undefined;
  const r = c.reranker as Record<string, unknown> | undefined;
  const rerankEnabled = r?.enabled !== false;

  // Resolve effective method values
  const embMethod = (e?.method as Record<string, unknown> | undefined);
  const methodImage = (embMethod?.image as string | undefined) ?? "text";
  const methodVideo = (embMethod?.video as string | undefined) ?? "text";

  // Rule D: reranker.enabled=false → skip all reranker validation
  if (!rerankEnabled) {
    return errors;
  }

  // Rule A: model only supports "text" → image and video must be "text"
  // Rule B: model supports ["text", "image"] but not "video" → video must be "text"
  if (e?.model) {
    const embedApi = detectEmbeddingApi((e.endpoint as string) ?? "");
    const capabilities = resolveEmbeddingModalities(embedApi, e.model as string);
    const hasImage = capabilities.includes("image");
    const hasVideo = capabilities.includes("video");

    if (!hasImage && !hasVideo) {
      // text-only model — both must be text
      if (methodImage !== "text") {
        errors.push(`Embedding model "${e.model}" is text-only. Set embedding.method.image to "text".`);
      }
      if (methodVideo !== "text") {
        errors.push(`Embedding model "${e.model}" is text-only. Set embedding.method.video to "text".`);
      }
    } else {
      // model has some multimodal support
      if (!hasImage && methodImage === "multimodal") {
        errors.push(`Embedding model "${e.model}" does not support image modality. Set embedding.method.image to "text" or use a multimodal model (e.g. Qwen/Qwen3-VL-Embedding-8B).`);
      }
      if (!hasVideo && methodVideo === "multimodal") {
        errors.push(`Embedding model "${e.model}" does not support video modality. Set embedding.method.video to "text" or use a model with video support.`);
      }
      if (!hasVideo) {
        // model supports image but not video
        if (methodVideo === "multimodal") {
          errors.push(`Embedding model "${e.model}" does not support video modality. Set embedding.method.video to "text".`);
        }
      }
    }
  }

  // Rule C: reranker.enabled=true + mm method → need reranker.multimodal
  const mmMethod = methodImage === "multimodal" || methodVideo === "multimodal";
  if (mmMethod) {
    const mm = r?.multimodal as Record<string, unknown> | undefined;
    if (!mm || !mm.apiKey) {
      errors.push("reranker.multimodal.apiKey must be configured when embedding.method.image or embedding.method.video is 'multimodal'");
    }
    // Check multimodal reranker supports the required modalities
    if (mm && mm.apiKey && mm.model) {
      const mmEndpoint = (mm.endpoint as string | undefined) || (r?.endpoint as string | undefined) || "";
      const mmCapabilities = resolveRerankerCapabilities(detectRerankerApi(mmEndpoint, mm.apiKey as string), mm.model as string);
      if (methodImage === "multimodal" && !mmCapabilities.includes("image")) {
        errors.push(`Reranker model "${mm.model}" does not support image modality. Multimodal reranker for images must support image.`);
      }
      if (methodVideo === "multimodal" && !mmCapabilities.includes("video")) {
        errors.push(`Reranker model "${mm.model}" does not support video modality. Multimodal reranker for video must support video.`);
      }
    }
  }

  return errors;
}

export function loadConfigFromFile(filePath: string): { config: ArkKBConfig | null; errors: string[] } {
  try {
    if (!existsSync(filePath)) {
      return { config: null, errors: [] };
    }
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const errors = validateConfig(parsed);
    if (errors.length > 0) {
      return { config: null, errors };
    }
    return { config: parsed as ArkKBConfig, errors: [] };
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      return { config: null, errors: [`Invalid JSON: ${err.message}`] };
    }
    return { config: null, errors: [`Failed to read config file: ${(err as Error).message}`] };
  }
}

export function resolveConfig(raw: ArkKBConfig): ResolvedConfig {
  const embedEndpoint = raw.embedding?.endpoint ?? "";
  const embedModel = raw.embedding?.model ?? DEFAULTS.embedding.model;
  const embedApiKey = raw.embedding?.apiKey ?? process.env.ARK_KB_EMBEDDING_API_KEY ?? DEFAULTS.embedding.apiKey;
  const rerankEndpoint = raw.reranker?.endpoint ?? DEFAULTS.reranker.endpoint;
  const rerankApiKey = raw.reranker?.apiKey ?? process.env.ARK_KB_RERANKER_API_KEY ?? DEFAULTS.reranker.apiKey;
  const pdfEndpoint = raw.pdfParser?.endpoint ?? DEFAULTS.pdfParser.endpoint;
  const pdfApiKey = raw.pdfParser?.apiKey ?? DEFAULTS.pdfParser.apiKey;

  return {
    knowledgePath: raw.knowledgePath ?? process.env.ARK_KB_KNOWLEDGE_PATH ?? "",
    storage: {
      dbPath: raw.storage?.dbPath ?? DEFAULTS.storage.dbPath,
    },
    embedding: {
      api: detectEmbeddingApi(embedEndpoint),
      endpoint: resolveEmbeddingEndpoint(detectEmbeddingApi(embedEndpoint), embedModel, raw.embedding?.endpoint || undefined),
      apiKey: embedApiKey,
      model: embedModel,
      dimensions: resolveEmbeddingDimensions(detectEmbeddingApi(embedEndpoint), embedModel, raw.embedding?.dimensions),
      batchSize: resolveEmbeddingBatchSize(detectEmbeddingApi(embedEndpoint), embedModel),
      method: {
        image: raw.embedding?.method?.image ?? DEFAULTS.embedding.method.image,
        video: raw.embedding?.method?.video ?? DEFAULTS.embedding.method.video,
      },
    },
    reranker: {
      enabled: raw.reranker?.enabled ?? DEFAULTS.reranker.enabled,
      api: detectRerankerApi(rerankEndpoint, rerankApiKey),
      endpoint: rerankEndpoint,
      apiKey: rerankApiKey,
      model: raw.reranker?.model ?? DEFAULTS.reranker.model,
      minScore: raw.reranker?.minScore ?? DEFAULTS.reranker.minScore,
      multimodal: raw.reranker?.multimodal,
    },
    pdfParser: {
      api: detectPdfParserApi(pdfEndpoint, pdfApiKey),
      endpoint: pdfEndpoint,
      apiKey: pdfApiKey,
      model: raw.pdfParser?.model ?? DEFAULTS.pdfParser.model,
      params: raw.pdfParser?.params ?? DEFAULTS.pdfParser.params,
    },
    search: {
      vectorWeight: raw.search?.vectorWeight ?? DEFAULTS.search.vectorWeight,
      topK: raw.search?.topK ?? DEFAULTS.search.topK,
      resultCount: raw.search?.resultCount ?? DEFAULTS.search.resultCount,
      bm25Enabled: raw.search?.bm25Enabled ?? DEFAULTS.search.bm25Enabled,
      fusionMethod: raw.search?.fusionMethod ?? DEFAULTS.search.fusionMethod,
    },
    chunking: {
      maxTokens: raw.chunking?.maxTokens ?? DEFAULTS.chunking.maxTokens,
      overlapTokens: raw.chunking?.overlapTokens ?? DEFAULTS.chunking.overlapTokens,
      strategy: raw.chunking?.strategy ?? DEFAULTS.chunking.strategy,
    },
    watcher: {
      enabled: raw.watcher?.enabled ?? DEFAULTS.watcher.enabled,
      paths: raw.watcher?.paths ?? DEFAULTS.watcher.paths,
      debounceMs: raw.watcher?.debounceMs ?? DEFAULTS.watcher.debounceMs,
      ignorePatterns: raw.watcher?.ignorePatterns ?? DEFAULTS.watcher.ignorePatterns,
    },
    videoSummarizer: {
      enabled: raw.videoSummarizer?.enabled ?? DEFAULTS.videoSummarizer.enabled,
      endpoint: raw.videoSummarizer?.endpoint ?? DEFAULTS.videoSummarizer.endpoint,
      apiKey: raw.videoSummarizer?.apiKey ?? DEFAULTS.videoSummarizer.apiKey,
      maxFrames: raw.videoSummarizer?.maxFrames ?? DEFAULTS.videoSummarizer.maxFrames,
    },
    imageSummarizer: {
      enabled: raw.imageSummarizer?.enabled ?? raw.videoSummarizer?.enabled ?? DEFAULTS.imageSummarizer.enabled,
      endpoint: raw.imageSummarizer?.endpoint ?? raw.videoSummarizer?.endpoint ?? DEFAULTS.imageSummarizer.endpoint,
      apiKey: raw.imageSummarizer?.apiKey ?? raw.videoSummarizer?.apiKey ?? DEFAULTS.imageSummarizer.apiKey,
    },
  };
}
