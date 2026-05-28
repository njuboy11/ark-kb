/**
 * Ark KB — Web UI API Server
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, createReadStream } from "node:fs";
import { join, basename } from "node:path";
import { UI_HTML } from "./html.js";

const PORT = 8765;

const routes: { method: string; pattern: RegExp; handler: (req: IncomingMessage, res: ServerResponse, params: Record<string,string>) => Promise<void> }[] = [];

function route(m: string, p: string, h: any) { routes.push({ method: m, pattern: new RegExp(`^${p}$`), handler: h }); }

function json(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage) { return new Promise<string>(r => { let b=""; req.on("data",c=>b+=c); req.on("end",()=>r(b)); }); }
async function parseBody(req: IncomingMessage) { try { return JSON.parse(await readBody(req)); } catch { return {}; } }

let _ctx: any = null;
let _logLines: string[] = [];

export function startWebServer(ctx: { kbManager: any; config: any; searcher: any }, logLines?: string[]) {
  _ctx = ctx;
  _logLines = logLines ?? [];
  setupRoutes();
  createServer(handleRequest).listen(PORT, () => console.log(`[Ark KB Web] http://localhost:${PORT}`));
}

function setupRoutes() {
  // KB
  route("GET","/api/kb",async(_,res)=>{ try { json(res, await _ctx.kbManager.listKBs()); } catch(e:any){ json(res,{error:e.message},500); } });
  route("POST","/api/kb",async(req,res)=>{ try { const {name}=await parseBody(req); if(!name) return json(res,{error:"Missing name"},400); await _ctx.kbManager.createKB(name); json(res,{ok:true}); } catch(e:any){ json(res,{error:e.message},500); } });
  route("DELETE","/api/kb/([^/]+)",async(_,res,params)=>{ try { await _ctx.kbManager.deleteKB(params["$1"]); json(res,{ok:true}); } catch(e:any){ json(res,{error:e.message},500); } });

  // Files
  route("GET","/api/kb/([^/]+)/files",async(_,res,params)=>{ try { const d=join(_ctx.config.knowledgePath,params["$1"]); const {readdirSync,statSync}=await import("node:fs"); if(!existsSync(d)) return json(res,[]); const fs=readdirSync(d).filter((f:string)=>!f.startsWith(".")).map((f:string)=>({name:f,size:statSync(join(d,f)).size,modified:statSync(join(d,f)).mtime.toISOString()})); json(res,fs); } catch(e:any){ json(res,{error:e.message},500); } });
  route("DELETE","/api/kb/([^/]+)/files/(.+)",async(_,res,params)=>{ try { const {unlinkSync}=await import("node:fs"); unlinkSync(join(_ctx.config.knowledgePath,params["$1"],decodeURIComponent(params["$2"]))); json(res,{ok:true}); } catch(e:any){ json(res,{error:e.message},500); } });
  route("GET","/api/kb/([^/]+)/files/(.+)",async(_,res,params)=>{ try { const fp=join(_ctx.config.knowledgePath,params["$1"],decodeURIComponent(params["$2"])); if(!existsSync(fp)){ res.writeHead(404); res.end(); return; } res.setHeader("Content-Disposition",`attachment; filename="${basename(fp)}"`); createReadStream(fp).pipe(res); } catch(e:any){ json(res,{error:e.message},500); } });

  // Config
  route("GET","/api/config",async(_,res)=>{ json(res, _ctx.config); });
  route("PUT","/api/config",async(req,res)=>{ try { Object.assign(_ctx.config, await parseBody(req)); json(res,{ok:true}); } catch(e:any){ json(res,{error:e.message},500); } });

  // Logs
  route("GET","/api/logs",async(req,res)=>{ const url=new URL(req.url!,"http://localhost"); const limit=parseInt(url.searchParams.get("limit")||"200"); json(res, _logLines.slice(-limit).reverse()); });

  // Chat
  route("POST","/api/chat",async(req,res)=>{ try { const {message,kbName}=await parseBody(req); if(!message) return json(res,{error:"Missing message"},400);
    const s=_ctx.searcher?.searcher; if(!s) return json(res,{answer:"服务就绪中，请稍后重试",sources:[]});
    const results=await s.search({query:message,topK:5,resultCount:5}); console.log("[Ark KB Web] Search results:", results.length, results.length>0?JSON.stringify(results[0]).slice(0,150):"EMPTY");
    const sources=results.map((r:any)=>({file:r.source_path||r.entry?.source_path||"unknown",text:(r.chunk_text||r.entry?.chunk_text||"").slice(0,500),score:r.score||0}));
    if(!sources.length) return json(res,{answer:"在知识库中没有找到相关内容。",sources:[]});
    const context=sources.map((s:any,i:number)=>`[${i+1}] ${s.file}\n${s.text}`).join("\n\n");
    const prompt=`你是一个知识库助手。根据资料回答问题。如果资料中没有答案，请诚实告知。\n\n资料：\n${context}\n\n问题：${message}\n\n请用中文回答，在引用处标注来源编号如[1]。`;
    const llm=_ctx.config.providers?.llm;
    if(llm){ try { const r=await fetch(`${llm.url}/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${llm.apiKey}`},body:JSON.stringify({model:llm.model?.id||"gpt-3.5-turbo",messages:[{role:"user",content:prompt}],max_tokens:2048})}); const d:any=await r.json(); json(res,{answer:d.choices?.[0]?.message?.content||"LLM 返回为空",sources}); } catch(e:any){ json(res,{answer:`LLM调用失败: ${e.message}`,sources}); } }
    else json(res,{answer:"未配置 LLM。请在 providers 中添加 llm。\n\n搜索到以下内容：\n\n"+sources.map((s:any,i:number)=>`**[${i+1}] ${s.file}** (${(s.score*100).toFixed(0)}%)\n${s.text.slice(0,300)}`).join("\n\n"),sources});
  } catch(e:any){ json(res,{answer:`错误: ${e.message}`,sources:[]},500); } });

  // Upload (multipart)
  route("POST","/api/kb/([^/]+)/upload",async(req,res,params)=>{ try { const kbDir=join(_ctx.config.knowledgePath,params["$1"]); const {mkdirSync,writeFileSync}=await import("node:fs"); mkdirSync(kbDir,{recursive:true}); const ct=req.headers["content-type"]||""; const bd=ct.split("boundary=")[1]; if(!bd) return json(res,{error:"Invalid multipart"},400);
    const body=await new Promise<Buffer>(r=>{const c:Buffer[]=[];req.on("data",x=>c.push(x));req.on("end",()=>r(Buffer.concat(c)));});
    const parts=body.toString("binary").split("--"+bd);
    let count=0;
    for(const part of parts){ const fn=part.match(/filename="([^"]+)"/); if(!fn) continue; const he=part.indexOf("\r\n\r\n"); if(he<0) continue; const data=Buffer.from(part.slice(he+4,part.endsWith("--")?-2:part.endsWith("\r\n")?-2:undefined),"binary"); writeFileSync(join(kbDir,fn[1]),data); count++; }
    json(res,{ok:true,count});
  } catch(e:any){ json(res,{error:e.message},500); } });

  // Home
  route("GET","/",async(_,res)=>{ res.setHeader("Content-Type","text/html; charset=utf-8"); res.end(UI_HTML); });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS"){ res.writeHead(204); res.end(); return; }
  const url=new URL(req.url||"/",`http://localhost:${PORT}`);
  for(const r of routes){
    if(req.method!==r.method) continue;
    const m=url.pathname.match(r.pattern);
    if(m){ try { await r.handler(req,res,{...m.groups,"$1":m[1]||"","$2":m[2]||""}); } catch(e:any){ json(res,{error:e.message},500); } return; }
  }
  json(res,{error:"Not found"},404);
}
