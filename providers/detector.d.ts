/**
 * Ark KB — Protocol Detector
 * Detect API protocol from URL. Default: openai.
 */
export type ProtocolId = "openai" | "cohere" | "anthropic" | "google" | "minimax-vlm" | "mineru";
export declare function detectProtocol(url: string): ProtocolId;
//# sourceMappingURL=detector.d.ts.map