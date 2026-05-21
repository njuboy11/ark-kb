/**
 * Ark KB — Tool Registration
 * Registers kb_search, kb_ingest, kb_remove, kb_status tools.
 */
// ============================================================================
// Tool Registration
// ============================================================================
export function registerKBTools(ark) {
    return [
        // ====================================================================
        // kb_search — Knowledge base semantic search
        // ====================================================================
        {
            name: "kb_search",
            description: "Search the knowledge base using hybrid BM25 + vector semantic search. " +
                "Supports text and images. Returns relevant chunks with source paths and images. " +
                "Use when the user asks to find something in their knowledge base documents or images.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Search query — describe naturally what you are looking for. " +
                            "E.g. 'the login page UI design', 'JWT authentication flow', 'Q2 product planning'.",
                    },
                    count: {
                        type: "number",
                        description: "Number of results to return (1-20, default: 6).",
                        default: 6,
                    },
                },
                required: ["query"],
            },
            async execute(_toolCallId, params) {
                try {
                    const results = await ark.search(params.query, { resultCount: params.count ?? 6 });
                    if (results.length === 0) {
                        return {
                            content: [{ type: "text", text: "No results found in knowledge base." }],
                        };
                    }
                    const resultText = results
                        .map((r, i) => `[${i + 1}] (score: ${(r.score * 100).toFixed(1)}%) — from **${r.source_path}**\n` +
                        `> ${r.chunk_text}\n` +
                        (r.images.length > 0 ? `   📎 Images: ${r.images.join(", ")}\n` : ""))
                        .join("\n---\n");
                    return {
                        content: [{ type: "text", text: resultText }],
                        data: {
                            results: results.map((r) => ({
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
                }
                catch (err) {
                    return {
                        content: [{ type: "text", text: `Knowledge base search failed: ${err}` }],
                    };
                }
            },
        },
        // ====================================================================
        // kb_ingest — Manually trigger file indexing
        // ====================================================================
        {
            name: "kb_ingest",
            description: "Manually trigger indexing of a file or all files in the knowledge base folder. " +
                "Use when files have been added or modified and you want immediate indexing without waiting for the file watcher.",
            parameters: {
                type: "object",
                properties: {
                    filePath: {
                        type: "string",
                        description: "Optional: specific file path (relative to knowledge base root) to index. " +
                            "Omit to re-index all files.",
                    },
                },
            },
            async execute(_toolCallId, params) {
                try {
                    if (params.filePath) {
                        const result = await ark.ingestFile(params.filePath);
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Indexed: ${result.source} (${result.entries} chunks)`,
                                },
                            ],
                        };
                    }
                    else {
                        const result = await ark.ingestDirectory();
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Re-indexed ${result.files} files, ${result.total} chunks total.`,
                                },
                            ],
                        };
                    }
                }
                catch (err) {
                    return {
                        content: [{ type: "text", text: `Indexing failed: ${err}` }],
                    };
                }
            },
        },
        // ====================================================================
        // kb_remove — Remove file index
        // ====================================================================
        {
            name: "kb_remove",
            description: "Remove a file's indexed chunks from the knowledge base. " +
                "Use when a file has been deleted and the watcher didn't catch it, " +
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
            async execute(_toolCallId, params) {
                try {
                    const deleted = await ark.removeSource(params.sourcePath);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Removed ${deleted} chunks for source: ${params.sourcePath}`,
                            },
                        ],
                    };
                }
                catch (err) {
                    return {
                        content: [{ type: "text", text: `Removal failed: ${err}` }],
                    };
                }
            },
        },
        // ====================================================================
        // kb_status — Knowledge base status overview
        // ====================================================================
        {
            name: "kb_status",
            description: "Show knowledge base status: total chunks, indexed files, and configuration summary. " +
                "Use to check if the knowledge base is healthy and which files are indexed.",
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
                                type: "text",
                                text: `**Ark KB Status**\n` +
                                    `- Total chunks: ${chunkCount}\n` +
                                    `- Indexed files: ${sources.length}\n` +
                                    `- Files: ${sources.join(", ") || "(empty)"}\n` +
                                    `- Knowledge path: ${ark.config.knowledgePath}\n` +
                                    `- Embedding model: ${ark.config.embedding.model} (${ark.config.embedding.dimensions}d)\n` +
                                    `- Embedding API: ${ark.config.embedding.api}\n` +
                                    `- Reranker: ${ark.config.reranker.api}\n` +
                                    `- File watcher: ${ark.config.watcher.enabled ? "active" : "inactive"}\n` +
                                    `- BM25: ${ark.config.search.bm25Enabled ? "enabled" : "disabled"}\n` +
                                    `  (vector weight: ${ark.config.search.vectorWeight})`,
                            },
                        ],
                    };
                }
                catch (err) {
                    return {
                        content: [{ type: "text", text: `Status check failed: ${err}` }],
                    };
                }
            },
        },
    ];
}
//# sourceMappingURL=tools.js.map