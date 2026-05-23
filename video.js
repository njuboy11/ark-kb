/**
 * Ark KB — Video Processor
 * ffmpeg frame extraction + tiling → MiniMax VLM → text summary → embedding
 */
import { spawn, execSync } from "node:child_process";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
// ============================================================================
// Public API
// ============================================================================
export async function summarizeVideo(filePath, config) {
    // 1. Probe video
    const info = await probeVideo(filePath);
    // 2. Adaptive frame interval
    const resolution = 360; // 360p for cost efficiency
    const { interval, frameCount } = adaptiveSampling(info.duration, config.maxFrames);
    // 3. Extract + tile frames
    const tmpDir = join(tmpdir(), `ark-video-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    try {
        const gridImage = await extractAndTile(filePath, tmpDir, {
            interval,
            frameCount,
            resolution,
            maxColumns: config.tileSize,
        });
        // 4. MiniMax VLM summary
        const gridBase64 = (await readFile(gridImage)).toString("base64");
        const summary = await callMiniMaxVLM(gridBase64, {
            apiKey: config.apiKey,
            endpoint: config.endpoint,
            timeoutMs: config.timeoutMs,
            interval,
            frameCount,
        });
        return { summary, frameCount, interval, duration: info.duration };
    }
    finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    }
}
// ============================================================================
// Video probing
// ============================================================================
async function probeVideo(filePath) {
    const result = execSync(`ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`, { encoding: "utf-8" });
    const data = JSON.parse(result);
    const videoStream = data.streams?.find((s) => s.codec_type === "video");
    const format = data.format ?? {};
    return {
        duration: parseFloat(videoStream?.duration ?? format.duration ?? "0"),
        width: videoStream?.width ?? 640,
        height: videoStream?.height ?? 360,
    };
}
// ============================================================================
// Adaptive sampling
// ============================================================================
function adaptiveSampling(duration, maxFrames) {
    let interval;
    if (duration <= 120) {
        interval = 1; // < 2 min: 1s interval
    }
    else if (duration <= 600) {
        interval = 2; // 2-10 min: 2s interval
    }
    else {
        interval = 3; // > 10 min: 3s interval
    }
    let frameCount = Math.floor(duration / interval);
    // Cap at maxFrames, adjust interval if needed
    if (frameCount > maxFrames) {
        interval = Math.ceil(duration / maxFrames);
        frameCount = maxFrames;
    }
    return { interval, frameCount };
}
async function extractAndTile(filePath, outputDir, opts) {
    console.log(`[ark-video] Compressing to ${opts.resolution}p proxy…`);
    const t0 = Date.now();
    // Step 0: Compress video to low-res proxy (avoid expensive full-res decode per frame)
    const proxyPath = join(outputDir, "proxy.mp4");
    await new Promise((resolve, reject) => {
        const proc = spawn("ffmpeg", [
            "-y",
            "-i", filePath,
            "-vf", `scale=${opts.resolution}:-2`,
            "-preset", "ultrafast",
            "-crf", "30",
            "-an", // No audio
            "-tune", "fastdecode",
            proxyPath,
        ], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        proc.on("close", (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`compress exit ${code}: ${stderr.slice(-200)}`));
        });
        proc.on("error", reject);
    });
    console.log(`[ark-video] Proxy done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // Step 1: Extract frames from proxy (no scale filter needed, already 360p)
    const t1 = Date.now();
    await new Promise((resolve, reject) => {
        const frameFilter = `fps=1/${opts.interval}`;
        const proc = spawn("ffmpeg", [
            "-y",
            "-i", proxyPath,
            "-an",
            "-vf", frameFilter,
            "-q:v", "50",
            join(outputDir, "frame_%04d.jpg"),
        ], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        proc.on("close", (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`frame extract exit ${code}: ${stderr.slice(-200)}`));
        });
        proc.on("error", reject);
    });
    console.log(`[ark-video] ${opts.frameCount} frames in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    // Step 2: Tile all frames into grid
    const cols = Math.min(opts.maxColumns, Math.ceil(Math.sqrt(opts.frameCount)));
    const gridPath = join(outputDir, "grid.jpg");
    await new Promise((resolve, reject) => {
        const proc = spawn("montage", [
            join(outputDir, "frame_*.jpg"),
            "-tile", `${cols}x`,
            "-geometry", `${opts.resolution}x+2+2`,
            "-background", "black",
            gridPath,
        ], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        proc.on("close", (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`montage exit ${code}: ${stderr.slice(-200)}`));
        });
        proc.on("error", reject);
    });
    return gridPath;
}
async function callMiniMaxVLM(base64Image, opts) {
    const prompt = [
        `这是一个视频的关键帧拼图，按时间从左到右、从上到下排列，每${opts.interval}秒一帧，共${opts.frameCount}帧。`,
        "请观看这些帧，用200-300字中文概括这个视频的内容，包括主题、主要场景、人物动作、关键事件等。",
    ].join(" ");
    const body = JSON.stringify({
        prompt,
        image_url: `data:image/jpeg;base64,${base64Image}`,
    });
    const response = await fetch(opts.endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${opts.apiKey}`,
            "MM-API-Source": "ark-kb",
        },
        signal: AbortSignal.timeout(opts.timeoutMs),
        body,
    });
    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`MiniMax VLM error (${response.status}): ${errText}`);
    }
    const data = await response.json();
    if (data.base_resp?.status_code !== 0) {
        throw new Error(`MiniMax VLM failed: ${data.base_resp?.status_msg ?? "unknown"}`);
    }
    return data.content ?? "";
}
//# sourceMappingURL=video.js.map