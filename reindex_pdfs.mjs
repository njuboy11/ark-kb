// Direct re-index: call ingester.ingestFile() directly (bypasses Layer 1 filesystem hash check)
// The DB hash check (Layer 3) will find no entries → proceed to index
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { KBManager } from "./kb-manager.js";

const config = JSON.parse(await readFile("./plugin-config.json", "utf-8"));

const pdfFiles = [
  "手把手带你快速了解一个行业-wwang.pdf",
  "智能搜索生成（高性能版） - 千帆AI应用开发者中心-API参考qianfan-api _ 百度智能云文档.pdf",
  "火山方舟_文本向量化 API_1775280229.pdf",
  "规律防癌体检的重要性及体检方案.pdf"
];

const kbDir = "/root/.openclaw/workspace/knowledge/default";

const km = new KBManager({
  knowledgePath: "/root/.openclaw/workspace/knowledge",
  dbPath: "/root/.ark-kb/lancedb-v2",
  vectorDim: config.embedding.dimensions,
  embedderConfig: {
    endpoint: config.embedding.endpoint,
    apiKey: config.embedding.apiKey,
    model: config.embedding.model,
  },
  videoConfig: {
    endpoint: config.videoSummarizer?.endpoint,
    apiKey: config.videoSummarizer?.apiKey,
    maxFrames: config.videoSummarizer?.maxFrames ?? 100,
  },
  imageConfig: {
    endpoint: config.imageSummarizer?.endpoint,
    apiKey: config.imageSummarizer?.apiKey,
  },
  embeddingMethod: {
    image: config.embedding.method.image,
    video: config.embedding.method.video,
  },
});
await km.init();

const ingester = km.getIngester("default");
if (!ingester) {
  console.log("No ingester found");
  process.exit(1);
}

for (const f of pdfFiles) {
  const filePath = join(kbDir, f);
  console.log(`\n索引: ${f}`);
  try {
    const result = await ingester.ingestFile(filePath);
    console.log(`  结果: ${result.entries} chunks, skipped=${result.skipped}`);
  } catch(e) {
    console.log(`  错误: ${e.message}`);
  }
}

await km.close();
console.log("\nDone!");
