/**
 * Ark KB — MinerU PDF Parser
 * Submits PDF → polls until done → downloads extracted content.
 */
import type { ResolvedProvider } from "../config.js";
export interface PDFParseResult {
    text: string;
    pages: number;
    taskId: string;
}
export declare function mineruParse(provider: ResolvedProvider, filePath: string, options?: {
    modelVersion?: string;
    enableFormula?: boolean;
    enableTable?: boolean;
}): Promise<PDFParseResult>;
//# sourceMappingURL=mineru.d.ts.map