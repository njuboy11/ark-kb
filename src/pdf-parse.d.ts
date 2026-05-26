declare module "pdf-parse" {
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: Record<string, unknown> | null;
    text: string;
    version: string;
  }
  interface PdfParseOptions {
    pagerender?: (pageData: { getTextContent: () => Promise<{ items: unknown[] }> }) => Promise<string>;
    max?: number;
    version?: string;
  }
  function pdfParse(
    dataBuffer: Buffer,
    options?: PdfParseOptions,
  ): Promise<PdfParseResult>;
  export = pdfParse;
}
