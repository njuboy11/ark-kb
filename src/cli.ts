/**
 * Ark KB — CLI
 * Manual debugging and administration tool.
 *
 * Usage:
 *   ark-kb search <query>           Search knowledge base
 *   ark-kb ingest <file>            Manually ingest a file
 *   ark-kb remove <source>          Remove chunks by source filename
 *   ark-kb status                   Show knowledge base status
 */

import { resolveConfig, loadConfigFromFile } from "./config.js";
import { ArkKB } from "./index.js";
import { join } from "node:path";
import { existsSync } from "node:fs";

// ============================================================================
// Help
// ============================================================================

function printHelp(): void {
  console.log(`
Ark KB CLI — knowledge base management

Usage:
  ark-kb search <query>           Search knowledge base
  ark-kb ingest <file>            Manually ingest a file
  ark-kb remove <source>          Remove all chunks for a source filename
  ark-kb status                   Show knowledge base status
  ark-kb config                   Print resolved config

Options:
  --no-rerank                     Disable reranker for search
  --top <n>                       Number of results (default: 6)
  --verbose                       Show detailed output
  --config <path>                 Path to plugin-config.json (default: auto-detect)

Examples:
  ark-kb search "锂电池 市场规模"
  ark-kb ingest /root/knowledge/video.mp4
  ark-kb remove video.mp4
  ark-kb status --verbose
`);
}

// ============================================================================
// Embedded in-memory store adapter (no OpenClaw runtime needed)
// ============================================================================

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args._.length === 0) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const cmd = args._[0];

  // Load config
  const configPath = args.config ?? findConfigPath();
  if (!configPath || !existsSync(configPath)) {
    console.error("❌ Config not found. Use --config <path> or place plugin-config.json next to the plugin.");
    process.exit(1);
  }

  const fileResult = loadConfigFromFile(configPath);
  if (!fileResult.config || fileResult.errors.length > 0) {
    console.error("❌ Config validation failed:");
    for (const err of fileResult.errors) console.error(`   - ${err}`);
    process.exit(1);
  }

  const resolved = resolveConfig(fileResult.config);
  const core = new ArkKB(fileResult.config);
  await core.init();

  try {
    switch (cmd) {
      case "search": {
        const query = args._.slice(1).join(" ") || args._[1];
        if (!query) { console.error("❌ Missing search query"); process.exit(1); }

        const result = await core.search(query, {
          rerankerEnabled: !args["no-rerank"],
          resultCount: args.top ?? 6,
        });

        if (result.length === 0) {
          console.log("(no results)");
        } else {
          for (const [i, r] of result.entries()) {
            const src = r.source_path || "?";
            const idx = r.total_chunks > 1 ? ` (${r.chunk_index + 1}/${r.total_chunks})` : "";
            console.log(`[${i + 1}] ${src}${idx} — score: ${(r.score * 100).toFixed(1)}%`);
            if (args.verbose) {
              const text = (r as any).chunk_text || r.chunk_text;
              console.log(`    ${(text || "").substring(0, 200)}`);
              const imgs = (r as any).images ? JSON.parse((r as any).images) : [];
              if (imgs.length > 0) console.log(`    🖼  ${imgs.join(", ")}`);
            }
          }
        }
        break;
      }

      case "ingest": {
        const filePath = args._[1];
        if (!filePath) { console.error("❌ Missing file path"); process.exit(1); }

        const absPath = filePath.startsWith("/") ? filePath : join(process.cwd(), filePath);
        if (!existsSync(absPath)) { console.error(`❌ File not found: ${absPath}`); process.exit(1); }

        // Only allow files within knowledgePath
        if (!absPath.startsWith(resolved.knowledgePath)) {
          console.error(`❌ File must be inside knowledge path: ${resolved.knowledgePath}`);
          process.exit(1);
        }

        const result = await core.ingestFile(absPath);
        if (result.skipped) {
          console.log(`⏭  Skipped: ${result.source}`);
        } else {
          console.log(`✅ Indexed: ${result.source} (${result.entries} chunks)`);
        }
        break;
      }

      case "remove": {
        const source = args._[1];
        if (!source) { console.error("❌ Missing source filename"); process.exit(1); }
        const removed = await core.removeSource(source);
        console.log(`🗑  Removed ${removed} chunks for: ${source}`);
        break;
      }

      case "status": {
        const status = await core.status();
        console.log(`Chunks: ${status.chunkCount}`);
        console.log(`Files:  ${status.sources.length}`);
        if (args.verbose && status.sources.length > 0) {
          console.log(`\nFiles:`);
          for (const s of status.sources) console.log(`  - ${s}`);
        }
        console.log(`DB:     ${resolved.storage.dbPath}`);
        console.log(`Emb:    ${resolved.embedding.model} (${resolved.embedding.dimensions}d)`);
        console.log(`Mode:   ${resolved.embeddingMode} | img=${resolved.image.rerankerMode} vid=${resolved.video.rerankerMode}`);
        break;
      }

      case "config": {
        console.log(JSON.stringify(resolved, null, 2));
        break;
      }

      default:
        console.error(`❌ Unknown command: ${cmd}`);
        printHelp();
        process.exit(1);
    }
  } finally {
    // Clean shutdown
    if (core.shutdown) await core.shutdown();
  }
}

// ============================================================================
// Helpers
// ============================================================================

interface ParsedArgs {
  _: string[];
  help?: boolean;
  "no-rerank"?: boolean;
  top?: number;
  verbose?: boolean;
  config?: string;
  [k: string]: unknown;
}

function parseArgs(raw: string[]): ParsedArgs {
  const result: ParsedArgs & { _: string[] } = { _: [] };
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === "--help" || raw[i] === "-h") {
      result.help = true;
    } else if (raw[i] === "--no-rerank") {
      result["no-rerank"] = true;
    } else if (raw[i] === "--verbose" || raw[i] === "-v") {
      result.verbose = true;
    } else if (raw[i] === "--top" && raw[i + 1]) {
      result.top = parseInt(raw[i + 1], 10);
      i++;
    } else if (raw[i] === "--config" && raw[i + 1]) {
      result.config = raw[i + 1];
      i++;
    } else if (!raw[i].startsWith("--")) {
      result._.push(raw[i]);
    }
    i++;
  }
  return result;
}

function findConfigPath(): string | null {
  // Check next to this script (plugin install dir)
  const candidates = [
    join(import.meta.dirname!, "plugin-config.json"),
    join(import.meta.dirname!, "..", "plugin-config.json"),
    join(import.meta.dirname!, "..", "..", "ark-kb", "plugin-config.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
