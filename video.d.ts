/**
 * Ark KB — Video Processor
 * ffmpeg frame extraction + tiling → MiniMax VLM → text summary → embedding
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
export declare function summarizeVideo(filePath: string, config: VideoSummaryConfig): Promise<VideoSummaryResult>;
//# sourceMappingURL=video.d.ts.map