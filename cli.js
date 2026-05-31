/**
 * Ark KB — CLI
 * Manual debugging and administration tool.
 *
 * Usage:
 *   ark-kb search <query>           Search knowledge base
 *   ark-kb ingest <file>            Manually ingest a file
 *   ark-kb remove <source>          Remove chunks by source filename
 *   ark-kb status                   Show knowledge base status
 *   ark-kb create <name>            Create a new knowledge base
 *   ark-kb delete <name>            Delete a knowledge base (y/n confirm)
 *   ark-kb list                     List all knowledge bases
 *   ark-kb compact --kb <name>      Compact & cleanup a KB
 *   ark-kb compact --all            Compact all KBs
 *   ark-kb heal --kb <name>         Incremental sync files → DB
 *   ark-kb heal --all               Heal all KBs
 *   ark-kb rebuild --kb <name>      Drop & rebuild a KB (y/n confirm)
 *   ark-kb rebuild --all            Rebuild all KBs (y/n confirm)
 *   ark-kb config                   Print resolved config
 */
import { resolveConfig, loadConfigFromFile } from "./config.js";
import { ArkKB } from "./index.js";
import { join, sep } from "node:path";
import { existsSync } from "node:fs";
// ============================================================================
// Help
// ============================================================================
function printHelp() {
    console.log(`
Ark KB CLI — knowledge base management

Usage:
  ark-kb search <query>           Search knowledge base
  ark-kb ingest <file>            Manually ingest a file
  ark-kb remove <source>          Remove all chunks for a source filename
  ark-kb status                   Show knowledge base status
  ark-kb create <name>            Create a new knowledge base
  ark-kb delete <name>            Delete a knowledge base
  ark-kb list                     List all knowledge bases
  ark-kb config                   Print resolved config

Options:
  --kb <name>                     Target knowledge base name (for search/remove/status)
  --no-rerank                     Disable reranker for search
  --top <n>                       Number of results (default: 6)
  --verbose                       Show detailed output
  --confirm                       Confirm destructive actions (delete)
  --config <path>                 Path to plugin-config.json (default: auto-detect)

Examples:
  ark-kb search "锂电池 市场规模"
  ark-kb search "电池" --kb medical
  ark-kb ingest /root/knowledge/video.mp4
  ark-kb remove video.mp4 --kb medical
  ark-kb status --kb medical --verbose
  ark-kb create my-kb
  ark-kb delete my-kb --confirm
  ark-kb list
`);
}
// ============================================================================
// Main
// ============================================================================
async function main() {
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
        for (const err of fileResult.errors)
            console.error(`   - ${err}`);
        process.exit(1);
    }
    const resolved = resolveConfig(fileResult.config);
    // CLI doesn't need the watcher
    fileResult.config.watcher = { ...(fileResult.config.watcher ?? {}), enabled: false };
    // CLI mode: skip email ingester initialization
    const cliConfig = { ...fileResult.config, emailIngester: { ...(fileResult.config.emailIngester ?? {}), enabled: false } };
    const core = new ArkKB(cliConfig);
    await core.init(null, { skipWebServer: true });
    // Shared --kb option
    const kbName = args.kb;
    try {
        switch (cmd) {
            case "search": {
                const query = args._.slice(1).join(" ") || args._[1];
                if (!query) {
                    console.error("❌ Missing search query");
                    process.exit(1);
                }
                const result = await core.search(query, {
                    kbName,
                    rerankerEnabled: !args["no-rerank"],
                    resultCount: args.top ?? 6,
                });
                if (result.length === 0) {
                    console.log("(no results)");
                }
                else {
                    for (const [i, r] of result.entries()) {
                        const src = r.source_path || "?";
                        const idx = r.total_chunks > 1 ? ` (${r.chunk_index + 1}/${r.total_chunks})` : "";
                        console.log(`[${i + 1}] ${src}${idx} — score: ${(r.score * 100).toFixed(1)}%`);
                        if (args.verbose) {
                            const text = r.chunk_text || r.chunk_text;
                            console.log(`    ${(text || "").substring(0, 200)}`);
                            const imgs = Array.isArray(r.images) ? r.images : (typeof r.images === "string" ? JSON.parse(r.images) : []);
                            if (imgs.length > 0)
                                console.log(`    🖼  ${imgs.join(", ")}`);
                        }
                    }
                }
                break;
            }
            case "ingest": {
                const filePath = args._[1];
                if (!filePath) {
                    console.error("❌ Missing file path");
                    process.exit(1);
                }
                const absPath = filePath.startsWith("/") ? filePath : join(process.cwd(), filePath);
                if (!existsSync(absPath)) {
                    console.error(`❌ File not found: ${absPath}`);
                    process.exit(1);
                }
                // Only allow files within knowledgePath
                if (!absPath.startsWith(resolved.knowledgePath + sep) || absPath === resolved.knowledgePath) {
                    console.error(`❌ File must be inside knowledge path: ${resolved.knowledgePath}`);
                    process.exit(1);
                }
                const result = await core.ingestFile(absPath);
                if (result.skipped) {
                    console.log(`⏭  Skipped: ${result.source}`);
                }
                else {
                    console.log(`✅ Indexed: ${result.source} (${result.entries} chunks)`);
                }
                break;
            }
            case "remove": {
                const source = args._[1];
                if (!source) {
                    console.error("❌ Missing source filename");
                    process.exit(1);
                }
                const removed = await core.removeSource(source, kbName);
                console.log(`🗑  Removed ${removed} chunks for: ${source}`);
                break;
            }
            case "status": {
                const status = await core.status(kbName);
                console.log(`Chunks: ${status.chunkCount}`);
                console.log(`Files:  ${status.sources.length}`);
                if (args.verbose && status.sources.length > 0) {
                    console.log(`\nFiles:`);
                    for (const s of status.sources)
                        console.log(`  - ${s}`);
                }
                console.log(`DB:     ${resolved.storage.dbPath}`);
                console.log(`Emb:    ${resolved.embedding.model} (${resolved.embedding.dimensions}d)`);
                console.log(`Method: img=${resolved.embedding.method.image} vid=${resolved.embedding.method.video}`);
                const emailEnabled = resolved.emailIngester?.enabled;
                console.log(`Email:  ${emailEnabled ? `enabled (${resolved.emailIngester.host})` : "disabled"}`);
                break;
            }
            case "create": {
                const name = args._[1];
                if (!name) {
                    console.error("❌ Missing knowledge base name");
                    process.exit(1);
                }
                await core.createKB(name);
                console.log(`Created KB: ${name}`);
                break;
            }
            case "delete": {
                const delName = args._[1];
                if (!delName) {
                    console.error("❌ Missing knowledge base name");
                    process.exit(1);
                }
                const info = (await core.kbManager.listKBs()).find(k => k.name === delName);
                console.log(`⚠️  This will PERMANENTLY delete the knowledge base "${delName}" and all its data.`);
                console.log(`   - Table "${delName}": ${info?.chunkCount ?? "?"} chunks, ${info?.fileCount ?? "?"} files will be lost`);
                const ok = await promptYN("\nContinue? (y/N): ");
                if (!ok) {
                    console.log("Aborted.");
                    process.exit(0);
                }
                await core.deleteKB(delName, true);
                console.log(`Deleted KB: ${delName}`);
                break;
            }
            case "list": {
                const kbs = await core.listKBs();
                if (kbs.length === 0) {
                    console.log("(no knowledge bases)");
                }
                else {
                    for (const kb of kbs) {
                        console.log(`${kb.name}  files=${kb.fileCount}  chunks=${kb.chunkCount}`);
                    }
                }
                break;
            }
            case "config": {
                console.log(JSON.stringify(resolved, null, 2));
                break;
            }
            case "compact": {
                const isAll = !!args.all;
                const isDryRun = !!args["dry-run"];
                const cleanupDays = args["cleanup-days"] ?? 7;
                const aggressive = !!args.aggressive || cleanupDays < 7;
                if (!args.kb && !isAll) {
                    console.error("❌ Must specify --kb <name> or --all");
                    process.exit(1);
                }
                if (isAll && args.kb) {
                    console.error("❌ Cannot use both --kb and --all");
                    process.exit(1);
                }
                const options = {
                    cleanupDays,
                    aggressive,
                    dryRun: isDryRun,
                };
                if (isDryRun) {
                    console.log("[Ark KB] DRY RUN — no changes will be made\n");
                }
                const label = isAll ? "all KBs" : args.kb;
                if (cleanupDays > 0 && cleanupDays < 7) {
                    console.log(`[Ark KB] ⚠️  cleanup-days=${cleanupDays} < 7-day safety period, enabling aggressive mode\n`);
                }
                console.log(`[Ark KB] Optimizing: ${label} (compact + prune ${cleanupDays}d + index remap)\n`);
                const totalStart = Date.now();
                let totalBytes = 0;
                let totalFrags = 0;
                let totalVersions = 0;
                const doCompact = async (kbName) => {
                    const stats = await core.kbManager.compact(kbName, options);
                    if (!stats)
                        return;
                    const kb = isAll ? `\u256d\u2500 ${stats.kbName} \u2500\u256e\n` : "";
                    if (kb)
                        console.log(kb);
                    if (stats.compaction) {
                        const c = stats.compaction;
                        console.log(`  \uD83D\uDD04 Compaction:  ${c.fragmentsBefore} \u2192 ${c.fragmentsAfter} fragments, freed ${fmtBytes(c.bytesFreed)}`);
                        totalFrags += c.fragmentsRemoved;
                        totalBytes += c.bytesFreed;
                    }
                    if (stats.prune) {
                        const p = stats.prune;
                        console.log(`  \uD83D\uDDD1 Prune:      ${p.oldVersionsRemoved} versions removed, ${fmtBytes(p.bytesRemoved)} freed`);
                        totalBytes += p.bytesRemoved;
                        totalVersions += p.oldVersionsRemoved;
                    }
                    console.log(`\u2705 ${stats.kbName} optimized (${stats.durationMs}ms)`);
                };
                if (isAll) {
                    const kbs = await core.kbManager.listKBs();
                    for (const kb of kbs) {
                        await doCompact(kb.name);
                    }
                    const dur = Date.now() - totalStart;
                    console.log(`\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n` +
                        `\u2705 All ${kbs.length} KBs compacted (${dur}ms)\n` +
                        `   Total: ${fmtBytes(totalBytes)} freed, ${totalFrags} fragments merged`);
                }
                else {
                    await doCompact(args.kb);
                }
                break;
            }
            case "heal": {
                const healAll = !!args.all;
                if (!args.kb && !healAll) {
                    console.error("❌ Must specify --kb <name> or --all");
                    process.exit(1);
                }
                if (healAll && args.kb) {
                    console.error("❌ Cannot use both --kb and --all");
                    process.exit(1);
                }
                const hStart = Date.now();
                if (healAll) {
                    console.log("[Ark KB] Healing all KBs...\n");
                    const result = await core.kbManager.healAll();
                    for (const [name, r] of Object.entries(result.byKB)) {
                        console.log(`  ✅ ${name}: healed ${r.healed}, skipped ${r.skipped}`);
                    }
                    console.log(`────────────────────────────────────────────────\n` +
                        `✅ All KBs healed (${Date.now() - hStart}ms): ${result.healed} healed, ${result.skipped} skipped`);
                }
                else {
                    const name = args.kb;
                    console.log(`[Ark KB] Healing: ${name}`);
                    const result = await core.kbManager.healKB(name);
                    console.log(`✅ ${name}: healed ${result.healed}, skipped ${result.skipped} (${Date.now() - hStart}ms)`);
                }
                break;
            }
            case "rebuild": {
                const rebuildAll = !!args.all;
                if (!args.kb && !rebuildAll) {
                    console.error("❌ Must specify --kb <name> or --all");
                    process.exit(1);
                }
                if (rebuildAll && args.kb) {
                    console.error("❌ Cannot use both --kb and --all");
                    process.exit(1);
                }
                // Show warning + y/n prompt
                const target = rebuildAll ? "all KBs" : `KB "${args.kb}"`;
                const kbList = rebuildAll
                    ? (await core.kbManager.listKBs()).map(k => k.name)
                    : [args.kb];
                console.log(`⚠️  This will DROP and REBUILD ${target}`);
                for (const name of kbList) {
                    const info = (await core.kbManager.listKBs()).find(k => k.name === name);
                    console.log(`   - Table "${name}": ${info?.chunkCount ?? "?"} chunks, ${info?.fileCount ?? "?"} files will be lost`);
                    console.log(`   - All files from ${resolved.knowledgePath}/${name} will be re-ingested`);
                }
                const ok = await promptYN("\nContinue? (y/N): ");
                if (!ok) {
                    console.log("Aborted.");
                    process.exit(0);
                }
                const rStart = Date.now();
                if (rebuildAll) {
                    console.log("\n[Ark KB] Rebuilding all KBs...\n");
                    const results = await core.kbManager.rebuildAll();
                    for (const r of results) {
                        console.log(`  ✅ ${r.kbName}: rebuilt, ${r.healed} re-ingested, ${r.skipped} skipped`);
                    }
                    const total = results.reduce((s, r) => s + r.healed, 0);
                    console.log(`────────────────────────────────────────────────\n` +
                        `✅ All ${results.length} KBs rebuilt (${Date.now() - rStart}ms): ${total} files re-ingested`);
                }
                else {
                    const name = args.kb;
                    console.log(`\n[Ark KB] Rebuilding: ${name}`);
                    const result = await core.kbManager.rebuildKB(name);
                    console.log(`✅ ${name} rebuilt: ${result.healed} re-ingested, ${result.skipped} skipped (${Date.now() - rStart}ms)`);
                }
                break;
            }
            default:
                console.error(`❌ Unknown command: ${cmd}`);
                printHelp();
                process.exit(1);
        }
    }
    finally {
        // Clean shutdown
        if (core.shutdown)
            await core.shutdown();
    }
}
function parseArgs(raw) {
    const result = { _: [] };
    let i = 0;
    while (i < raw.length) {
        if (raw[i] === "--help" || raw[i] === "-h") {
            result.help = true;
        }
        else if (raw[i] === "--kb" && raw[i + 1]) {
            result.kb = raw[i + 1];
            i++;
        }
        else if (raw[i] === "--no-rerank") {
            result["no-rerank"] = true;
        }
        else if (raw[i] === "--confirm") {
            result.confirm = true;
        }
        else if (raw[i] === "--verbose" || raw[i] === "-v") {
            result.verbose = true;
        }
        else if (raw[i] === "--top" && raw[i + 1]) {
            result.top = parseInt(raw[i + 1], 10);
            i++;
        }
        else if (raw[i] === "--config" && raw[i + 1]) {
            result.config = raw[i + 1];
            i++;
        }
        else if (raw[i] === "--all") {
            result.all = true;
        }
        else if (raw[i] === "--cleanup-days" && raw[i + 1]) {
            result["cleanup-days"] = parseInt(raw[i + 1], 10);
            i++;
        }
        else if (raw[i] === "--op" && raw[i + 1]) {
            result.op = raw[i + 1];
            i++;
        }
        else if (raw[i] === "--aggressive") {
            result.aggressive = true;
        }
        else if (raw[i] === "--dry-run") {
            result["dry-run"] = true;
        }
        else if (!raw[i].startsWith("--")) {
            result._.push(raw[i]);
        }
        i++;
    }
    return result;
}
function fmtBytes(bytes) {
    if (bytes === 0)
        return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + " " + units[i];
}
async function promptYN(question) {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
        });
    });
}
function findConfigPath() {
    // Check next to this script (plugin install dir)
    const candidates = [
        join(import.meta.dirname, "plugin-config.json"),
        join(import.meta.dirname, "..", "plugin-config.json"),
        join(import.meta.dirname, "..", "..", "ark-kb", "plugin-config.json"),
    ];
    for (const p of candidates) {
        if (existsSync(p))
            return p;
    }
    return null;
}
main().catch((err) => {
    console.error("❌", err.message);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map