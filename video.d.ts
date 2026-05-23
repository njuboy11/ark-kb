/**
 * Ark KB — Video Processor
 * ffmpeg frame extraction + tiling → MiniMax VLM → text summary → embedding
 * Also supports multimodal mode: extract key frames for direct multimodal embedding.
 */
export interface VideoInfo {
    duration: number;
    width: number;
    height: number;
}
export interface VideoSummaryConfig {
    apiKey: string;
    endpoint: string;
    timeoutMs: number;
    maxFrames: number;
    tileSize: number;
}
export interface VideoSummaryResult {
    summary: string;
    frameCount: number;
    interval: number;
    duration: number;
}
export interface KeyFrameResult {
    /** Paths to extracted frame images (for multimodal embedding) */
    framePaths: string[];
    frameCount: number;
    interval: number;
    duration: number;
}
export declare function summarizeVideo(filePath: string, config: VideoSummaryConfig): Promise<VideoSummaryResult>;
/**
 * Extract key frames for multimodal embedding (no VLM summary).
 * Returns fewer frames than text mode since each frame gets embedded individually.
 */
export declare function extractKeyFrames(filePath: string, maxFrames: number): Promise<KeyFrameResult>;
/**
 * Summarize a single image via VLM (used when image.rerankerMode = "text").
 */
export declare function summarizeImage(imagePath: string, config: {
    apiKey: string;
    endpoint: string;
    timeoutMs: number;
}): Promise<string>;
//# sourceMappingURL=video.d.ts.map