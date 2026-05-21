/**
 * Ark KB — Tool Registration
 * 向 OpenClaw 注册 kb_search / kb_ingest / kb_remove / kb_status 等工具
 */

import { ArkKB } from "./index.js";

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * 注册 ark-kb 工具到 OpenClaw
 */
export function registerKBTools(ark: ArkKB) {
  return [
    // ====================================================================
    // kb_search — 知识库语义搜索
    // ====================================================================
    {
      name: "kb_search",
      description:
        "Search the knowledge base using semantic search. Supports text and images (multimodal). " +
        "Returns relevant chunks with source file paths and linked images. " +
        "Use when the user asks to find something in their knowledge base documents or images.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query — describe what you're looking for naturally. " +
              "E.g. 'the login page UI design', 'JWT authentication flow', 'Q2 planning document'.",
          },
          count: {
            type: "number",
            description: "Number of results to return (1-20, default: 6)",
            default: 6,
          },
        },
        required: ["query"],
      },
      async execute(_toolCallId: string, params: { query: string; count?: number }) {
        try {
          const results = await ark.search(params.query, {
            resultCount: params.count ?? 6,
          });

          if (results.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No results found in knowledge base." }],
            };
          }

          // Format results with source tracking
          const resultText = results
            .map(
              (r: any, i: number) =>
                `[${i + 1}] (score: ${(r.score * 100).toFixed(1)}%) — from **${r.source_path}**\n` +
                `> ${r.chunk_text}\n` +
                (r.images.length > 0 ? `   📎 Images: ${r.images.join(", ")}\n` : ""),
            )
            .join("\n---\n");

          return {
            content: [{ type: "text" as const, text: resultText }],
            // Also return raw data for programmatic use
            data: {
              results: results.map((r: any) => ({
                score: r.score,
                chunk_text: r.chunk_text,
                source_path: r.source_path,
                chunk_index: r.chunk_index,
                total_chunks: r.total_chunks,
                images: r.images,
                file_type: r.file_type,
              })),
            },
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Knowledge base search failed: ${err}` }],
          };
        }
      },
    },

    // ====================================================================
    // kb_ingest — 手动触发文件索引
    // ====================================================================
    {
      name: "kb_ingest",
      description:
        "Manually trigger indexing of a file or all files in the knowledge base folder. " +
        "Use when you've added or modified files and want immediate indexing without waiting for the file watcher.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "Optional: specific file path (relative to knowledge base folder) to index. " +
              "Omit to re-index all files in the knowledge base folder.",
          },
        },
      },
      async execute(_toolCallId: string, params: { filePath?: string }) {
        try {
          if (params.filePath) {
            const result = await ark.ingestFile(params.filePath);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Indexed: ${result.source} (${result.entries} chunks)`,
                },
              ],
            };
          } else {
            // Re-index all — use the ingester
            const result = await ark.ingester.ingestDirectory(ark.config.knowledgePath);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Re-indexed ${result.files} files, ${result.total} chunks total.`,
                },
              ],
            };
          }
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Indexing failed: ${err}` }],
          };
        }
      },
    },

    // ====================================================================
    // kb_remove — 从知识库移除文件索引
    // ====================================================================
    {
      name: "kb_remove",
      description:
        "Remove a file's indexed chunks from the knowledge base. " +
        "Use when you've deleted a file and the auto-watcher didn't catch it, " +
        "or when you want to manually purge a file's data.",
      parameters: {
        type: "object",
        properties: {
          sourcePath: {
            type: "string",
            description: "Source file path (basename, e.g. 'product-manual.pdf') to remove from index.",
          },
        },
        required: ["sourcePath"],
      },
      async execute(_toolCallId: string, params: { sourcePath: string }) {
        try {
          const deleted = await ark.removeSource(params.sourcePath);
          return {
            content: [
              {
                type: "text" as const,
                text: `Removed ${deleted} chunks for source: ${params.sourcePath}`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Removal failed: ${err}` }],
          };
        }
      },
    },

    // ====================================================================
    // kb_status — 知识库状态概览
    // ====================================================================
    {
      name: "kb_status",
      description:
        "Show knowledge base status: total chunks, indexed files, and configuration summary. " +
        "Use to check if the knowledge base is healthy and what files are indexed.",
      parameters: {
        type: "object",
        properties: {},
      },
      async execute() {
        try {
          const { chunkCount, sources } = await ark.status();
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `**Ark KB Status**\n` +
                  `- Total chunks: ${chunkCount}\n` +
                  `- Indexed files: ${sources.length}\n` +
                  `- Files: ${sources.join(", ") || "(empty)"}\n` +
                  `- Knowledge path: ${ark.config.knowledgePath}\n` +
                  `- Embedding model: ${ark.config.embeddingModel} (${ark.config.vectorDim}d)\n` +
                  `- Reranker: ${ark.config.rerankerEnabled ? "enabled" : "disabled"}\n` +
                  `- File watcher: ${ark.config.enableWatcher ? "active" : "inactive"}`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Status check failed: ${err}` }],
          };
        }
      },
    },
  ];
}
