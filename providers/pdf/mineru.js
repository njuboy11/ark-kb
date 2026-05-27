/**
 * Ark KB — MinerU PDF Parser
 * Submits PDF → polls until done → downloads extracted content.
 */
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
export async function mineruParse(provider, filePath, options) {
    const headers = {
        "Authorization": `Bearer ${provider.apiKey || ""}`,
    };
    // Step 1: Submit file
    const formData = new FormData();
    const fileData = new Blob([readFileSync(filePath)], { type: "application/pdf" });
    formData.append("file", fileData, basename(filePath));
    formData.append("enable_formula", String(options?.enableFormula ?? true));
    formData.append("enable_table", String(options?.enableTable ?? true));
    if (options?.modelVersion) {
        formData.append("model_version", options.modelVersion);
    }
    const submitUrl = `${provider.url}/extract`;
    const submitRes = await fetch(submitUrl, {
        method: "POST",
        headers,
        body: formData,
    });
    if (!submitRes.ok) {
        const err = await submitRes.text();
        throw new Error(`MinerU submit error (${submitRes.status}): ${err}`);
    }
    const submitData = (await submitRes.json());
    const taskId = submitData.data?.task_id;
    if (!taskId)
        throw new Error("MinerU submit returned no task_id");
    // Step 2: Poll until done
    const pollUrl = `${provider.url}/${taskId}`;
    const timeoutMs = 300_000;
    const intervalMs = 5_000;
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        await new Promise((r) => setTimeout(r, intervalMs));
        const pollRes = await fetch(pollUrl, { headers });
        if (!pollRes.ok) {
            const err = await pollRes.text();
            throw new Error(`MinerU poll error (${pollRes.status}): ${err}`);
        }
        const pollData = (await pollRes.json());
        if (pollData.code !== 0) {
            throw new Error(`MinerU poll failed: ${pollData.msg || JSON.stringify(pollData)}`);
        }
        const state = pollData.data?.state;
        if (state === "done") {
            const fullZipUrl = pollData.data?.full_zip_url;
            if (!fullZipUrl)
                throw new Error("MinerU task done but no full_zip_url");
            const totalPages = pollData.data?.extract_progress?.total_pages ?? 0;
            // Step 3: Download zip & extract
            const tmpDir = mkdtempSync(join(tmpdir(), "ark-kb-mineru-"));
            const zipPath = join(tmpDir, "result.zip");
            try {
                const zipRes = await fetch(fullZipUrl);
                if (!zipRes.ok)
                    throw new Error(`MinerU download error (${zipRes.status})`);
                writeFileSync(zipPath, Buffer.from(await zipRes.arrayBuffer()));
                execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { stdio: "pipe" });
                // Collect all .md files
                const parts = [];
                const { readdirSync, readFileSync, statSync } = await import("node:fs");
                function collectMd(dir) {
                    for (const entry of readdirSync(dir)) {
                        const full = join(dir, entry);
                        if (statSync(full).isDirectory()) {
                            collectMd(full);
                        }
                        else if (entry.endsWith(".md")) {
                            parts.push(readFileSync(full, "utf-8"));
                        }
                    }
                }
                collectMd(tmpDir);
                return { text: parts.join("\n\n"), pages: totalPages, taskId };
            }
            finally {
                // Cleanup temp dir
                try {
                    execSync(`rm -rf "${tmpDir}"`, { stdio: "pipe" });
                }
                catch { }
            }
        }
    }
    throw new Error(`MinerU task ${taskId} timed out after ${timeoutMs / 1000}s`);
}
//# sourceMappingURL=mineru.js.map