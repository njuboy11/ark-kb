/**
 * Ark KB — Tool Registration
 * Registers kb_search, kb_ingest, kb_remove, kb_status tools with OpenClaw.
 */
// ============================================================================
// Tool Registration
// ============================================================================
export function registerKBTools(ark) {
    return [
        // ====================================================================
        // kb_search — Hybrid semantic + keyword search
        // ====================================================================
        {
            name: "kb_search",
            description: "Search the knowledge base using hybrid vector + BM25 search with optional reranking. " +
                "Supports text, images, and PDFs. " +
                "Use when the user wants to find something in their personal knowledge base documents.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Natural language search query. E.g. 'login page design', 'JWT authentication flow', 'Q2 planning doc'.",
                    },
                    count: {
                        type: "number",
                        description: "Number of results to return (1-20, default: from config, typically 6).",
                    },
                },
                required: ["query"],
            },
            async execute(_toolCallId, params) {
                try {
                    const results = await ark.search(params.query, {
                        resultCount: params.count,
                        rerankerEnabled: true,
                    });
                    if (results.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No results found in knowledge base.",
                                },
                            ],
                        };
                    }
                    const resultText = results
                        .map((r, i) => `[${i + 1}] (score: ${(r.score * 100).toFixed(1)}%) — **${r.source_path}** ` +
                        `(${r.chunk_index + 1}/${r.total_chunks})\n` +
                        `> ${r.chunk_text}\n` +
                        (r.images.length > 0 ? `  📎 Images: ${r.images.join(", ")}\n` : ""))
                        .join("\n---\n");
                    return {
                        content: [{ type: "text", text: resultText }],
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
                }
                catch (err) {
                    return {
                        content: [
                            {
                                type: "text",
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
            description: "Manually trigger indexing of a file or all files in the knowledge base folder. " +
                "Use when files have been added or modified and you want immediate indexing " +
                "without waiting for the file watcher.",
            parameters: {
                type: "object",
                properties: {
                    filePath: {
                        type: "string",
                        description: "Optional absolute or relative file path to index. " +
                            "Omit to re-index all files in the knowledge base folder.",
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
                                    text: `Indexed: ${result.source} (${result.entries} chunks)` +
                                        (result.skipped ? " [skipped - no change]" : ""),
                                },
                            ],
                        };
                    }
                    else {
                        const result = await ark.ingester.ingestDirectory(ark.config.knowledgePath);
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Re-indexed ${result.files} files, ${result.total} chunks total` +
                                        (result.errors > 0 ? ` (${result.errors} errors)` : ""),
                                },
                            ],
                        };
                    }
                }
                catch (err) {
                    return {
                        content: [
                            {
                                type: "text",
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
            description: "Remove all indexed chunks for a given source file from the knowledge base. " +
                "Use when a file has been deleted (or renamed) and the watcher didn't catch it, " +
                "or when you want to manually purge a file's data.",
            parameters: {
                type: "object",
                properties: {
                    sourcePath: {
                        type: "string",
                        description: "Source file basename (e.g. 'product-manual.pdf') to remove from index.",
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
                        content: [
                            {
                                type: "text",
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
            description: "Show knowledge base status: total chunks, indexed files, configuration summary. " +
                "Use to check health and see what files are indexed.",
            parameters: {
                type: "object",
                properties: {},
            },
            async execute() {
                try {
                    const { chunkCount, sources } = await ark.status();
                    const cfg = ark.config;
                    return {
                        content: [
                            {
                                type: "text",
                                text: `**Ark KB Status**\n` +
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
                }
                catch (err) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Status check failed: ${err.message}`,
                            },
                        ],
                    };
                }
            },
        },
    ];
}
//# sourceMappingURL=tools.js.map