/**
 * Ark KB — Tool Registration
 * Registers kb_search, kb_ingest, kb_remove, kb_status,
 * kb_create, kb_delete, kb_list tools with OpenClaw.
 */

import { ArkKB } from "./index.js";

// ============================================================================
// Tool Registration
// ============================================================================

export function registerKBTools(ark: ArkKB) {
  return [

    // ====================================================================
    // kb_search — Hybrid semantic + keyword search
    // ====================================================================
    {
      name: "kb_search",
      description:
        "Search the knowledge base using hybrid vector + BM25 search with optional reranking. " +
        "Supports text, images, and PDFs. " +
        "Use when the user wants to find something in their personal knowledge base documents.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Natural language search query. E.g. 'login page design', 'JWT authentication flow', 'Q2 planning doc'.",
          },
          count: {
            type: "number",
            description: "Number of results to return (1-20, default: from config, typically 6).",
          },
          kb: {
            type: "string",
            description:
              "Optional knowledge base name to search within. " +
              "If omitted, searches across all knowledge bases.",
          },
          fileType: {
            type: "string",
            description:
              "Filter by file extension. " +
              "E.g. 'xlsx' for Excel files, 'pdf' for PDFs, 'docx' for Word documents. " +
              "Use this when the user wants to limit results to a specific file type.",
          },
        },
        required: ["query"],
      },

      async execute(
        _toolCallId: string,
        params: { query: string; count?: number; kb?: string; fileType?: string },
      ) {
        try {
          const results = await ark.search(params.query, {
            resultCount: params.count,
            rerankerEnabled: true,
            kbName: params.kb,
            fileType: params.fileType,
          });

          if (results.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "No results found in knowledge base.",
                },
              ],
            };
          }

          const resultText = results
            .map(
              (r, i) =>
                `[${i + 1}] (score: ${(r.score * 100).toFixed(1)}%) — **${r.source_path}** ` +
                `(${r.chunk_index + 1}/${r.total_chunks})\n` +
                `> ${r.chunk_text}\n` +
                (r.images.length > 0 ? `  📎 Images: ${r.images.join(", ")}\n` : ""),
            )
            .join("\n---\n");

          return {
            content: [{ type: "text" as const, text: resultText }],
            data: {
              results: results.map(r => ({
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
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Search failed: ${err.message}`,
              },
            ],
          };
        }
      },
    },

    // ====================================================================
    // kb_ingest — Manually trigger indexing
    // ====================================================================
    {
      name: "kb_ingest",
      description:
        "Manually trigger indexing of a file or all files in the knowledge base folder. " +
        "Use when files have been added or modified and you want immediate indexing " +
        "without waiting for the file watcher. File is automatically routed by path.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "Optional absolute or relative file path to index. " +
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
                  text: `Indexed: ${result.source} (${result.entries} chunks)` +
                    (result.skipped ? " [skipped - no change]" : ""),
                },
              ],
            };
          } else {
            const result = await ark.kbManager.heal(ark.config.knowledgePath);
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Re-indexed ${result.healed} files, ${result.skipped} skipped`,
                },
              ],
            };
          }
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Indexing failed: ${err.message}`,
              },
            ],
          };
        }
      },
    },

    // ====================================================================
    // kb_remove — Remove a source's indexed chunks
    // ====================================================================
    {
      name: "kb_remove",
      description:
        "Remove all indexed chunks for a given source file from the knowledge base. " +
        "Use when a file has been deleted (or renamed) and the watcher didn't catch it, " +
        "or when you want to manually purge a file's data.",
      parameters: {
        type: "object",
        properties: {
          sourcePath: {
            type: "string",
            description:
              "Source file basename (e.g. 'product-manual.pdf') to remove from index.",
          },
          kb: {
            type: "string",
            description:
              "Optional knowledge base name. " +
              "If omitted, removes from the default/global knowledge base.",
          },
        },
        required: ["sourcePath"],
      },

      async execute(
        _toolCallId: string,
        params: { sourcePath: string; kb?: string },
      ) {
        try {
          const deleted = await ark.removeSource(params.sourcePath, params.kb);
          return {
            content: [
              {
                type: "text" as const,
                text: `Removed ${deleted} chunks for source: ${params.sourcePath}` +
                  (params.kb ? ` (KB: ${params.kb})` : ""),
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Removal failed: ${err.message}`,
              },
            ],
          };
        }
      },
    },

    // ====================================================================
    // kb_status — Knowledge base health summary
    // ====================================================================
    {
      name: "kb_status",
      description:
        "Show knowledge base status: total chunks, indexed files, configuration summary. " +
        "Use to check health and see what files are indexed.",
      parameters: {
        type: "object",
        properties: {
          kb: {
            type: "string",
            description:
              "Optional knowledge base name. " +
              "If omitted, shows status for the default/global knowledge base.",
          },
        },
      },

      async execute(_toolCallId: string, params: { kb?: string }) {
        try {
          const status = await ark.status(params.kb);
          const cfg = ark.config;
          const chunkCount = typeof status === "object" && "chunkCount" in status
            ? status.chunkCount
            : status;
          const sources = typeof status === "object" && "sources" in status
            ? status.sources
            : [];

          return {
            content: [
              {
                type: "text" as const,
                text:
                  `**Ark KB Status**${params.kb ? ` (KB: ${params.kb})` : ""}\n` +
                  `- Chunks: ${chunkCount}\n` +
                  `- Files: ${sources.length}\n` +
                  (sources.length > 0 ? `- File list: ${sources.join(", ")}\n` : "") +
                  `- Knowledge path: ${cfg.knowledgePath}\n` +
                  `- DB path: ${cfg.storage.dbPath}\n` +
                  `- Embedding: ${cfg.embedding.model} (${cfg.embedding.dimensions}d, ${cfg.embedding.api})\n` +
                  `- Embedding endpoint: ${cfg.embedding.endpoint}\n` +
                  `- Chunking: ${cfg.chunking.strategy} (maxTokens=${cfg.chunking.maxTokens}, overlap=${cfg.chunking.overlapTokens})\n` +
                  `- Search: vectorWeight=${cfg.search.vectorWeight}, topK=${cfg.search.topK}, resultCount=${cfg.search.resultCount}\n` +
                  `- Reranker: ${cfg.reranker?.api ?? "none"} (minScore=${cfg.reranker?.minScore ?? "N/A"})\n` +
                  `- File watcher: ${cfg.watcher?.enabled ? "active" : "inactive"}\n` +
                  (cfg.watcher?.enabled && cfg.watcher.paths ? `  Additional watch paths: ${cfg.watcher.paths.join(", ")}\n` : ""),
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Status check failed: ${err.message}`,
              },
            ],
          };
        }
      },
    },

    // ====================================================================
    // kb_create — Create a new knowledge base
    // ====================================================================
    {
      name: "kb_create",
      description:
        "Create a new knowledge base. " +
        "Use when the user wants to create a new, separate knowledge base.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the new knowledge base to create.",
          },
        },
        required: ["name"],
      },

      async execute(_toolCallId: string, params: { name: string }) {
        try {
          await ark.createKB(params.name);
          return {
            content: [
              {
                type: "text" as const,
                text: `✅ Knowledge base "${params.name}" created successfully.`,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ Failed to create knowledge base "${params.name}": ${err.message}`,
              },
            ],
          };
        }
      },
    },

    // ====================================================================
    // kb_delete — Delete a knowledge base
    // ====================================================================
    {
      name: "kb_delete",
      description:
        "Delete a knowledge base and all its indexed data. " +
        "⚠️ This action is irreversible. Pass confirm=true to proceed with deletion.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the knowledge base to delete.",
          },
          confirm: {
            type: "boolean",
            description:
              "Set to true to confirm deletion. " +
              "If false or omitted, returns a warning prompt instead of deleting.",
          },
        },
        required: ["name"],
      },

      async execute(
        _toolCallId: string,
        params: { name: string; confirm?: boolean },
      ) {
        // confirm=true → actually delete
        if (params.confirm === true) {
          try {
            await ark.deleteKB(params.name, true);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `🗑️ Knowledge base "${params.name}" has been deleted.`,
                },
              ],
            };
          } catch (err: any) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `❌ Failed to delete knowledge base "${params.name}": ${err.message}`,
                },
              ],
            };
          }
        }

        // confirm=false or omitted → return confirmation prompt
        const promptResult = await ark.deleteKB(params.name, false);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `⚠️ **Risk Warning**\n` +
                `Deleting the knowledge base **"${params.name}"** will permanently remove all indexed data and cannot be undone.\n\n` +
                `To confirm deletion, run the same command again with \`confirm: true\`.\n\n` +
                (promptResult
                  ? `Additional confirmation from system:\n${promptResult}`
                  : ""),
            },
          ],
        };
      },
    },

    // ====================================================================
    // kb_list — List all knowledge bases
    // ====================================================================
    {
      name: "kb_list",
      description:
        "List all knowledge bases with their chunk counts and file counts. " +
        "Use when the user wants to see what knowledge bases exist.",
      parameters: {
        type: "object",
        properties: {},
      },

      async execute() {
        try {
          const kbs = await ark.listKBs();

          if (!kbs || kbs.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "No knowledge bases found.",
                },
              ],
            };
          }

          const lines = kbs.map(
            kb =>
              `- **${kb.name}** — ${kb.chunkCount ?? "?"} chunks, ${kb.fileCount ?? "?"} files` +
              (kb.path ? ` (path: ${kb.path})` : ""),
          );

          return {
            content: [
              {
                type: "text" as const,
                text: `**Knowledge Bases (${kbs.length})**\n${lines.join("\n")}`,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to list knowledge bases: ${err.message}`,
              },
            ],
          };
        }
      },
    },

  ];
}
