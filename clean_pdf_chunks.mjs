import * as lancedb from "@lancedb/lancedb";

const db = await lancedb.connect("/root/.ark-kb/lancedb-v2");
const table = await db.openTable("default");

const before = await table.countRows();
console.log("清理前:", before, "chunks");

const toClean = [
  "规律防癌体检的重要性及体检方案.pdf",
  "火山方舟_文本向量化 API_1775280229.pdf",
  "手把手带你快速了解一个行业-wwang.pdf",
  "智能搜索生成（高性能版） - 千帆AI应用开发者中心-API参考qianfan-api _ 百度智能云文档.pdf"
];

for (const src of toClean) {
  try {
    await table.delete(`source_path = '${src.replace(/'/g, "''")}'`);
    console.log("  已删除:", src);
  } catch(e) {
    console.log("  删除失败:", src, e.message);
  }
}

const after = await table.countRows();
console.log("清理后:", after, "chunks");
console.log("共移除:", before - after, "chunks");
