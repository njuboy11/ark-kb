/**
 * Ark KB — Email Ingester
 * Monitors an IMAP mailbox and auto-ingests email attachments into knowledge bases.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { KBManager } from "./kb-manager.js";

// ============================================================================
// Types
// ============================================================================

export interface EmailIngesterConfig {
  enabled: boolean;
  host: string;
  port: number;
  tls: boolean;
  user: string;
  password: string;
  scanIntervalMs: number;
  maxRetries: number;
}

export interface EmailState {
  lastUid: number;
  lastScan: number;
  totalProcessed: number;
  failed: Array<{
    messageId: string;
    error: string;
    retries: number;
    timestamp: number;
  }>;
}

interface AttachmentInfo {
  filename: string;
  mimeType: string;
  data: Buffer;
}

interface EmailMessage {
  messageId: string;
  subject: string;
  body: string;
  attachments: AttachmentInfo[];
}

// ============================================================================
// EmailIngester
// ============================================================================

export class EmailIngester {
  private config: EmailIngesterConfig;
  private kbManager: KBManager;
  private knowledgePath: string;
  private llmClient: { endpoint: string; apiKey: string; model: string };
  private emailStatePath: string;
  private state: EmailState;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private imapClient: any = null;
  private ImapFlow: any = null;

  constructor(opts: {
    config: EmailIngesterConfig;
    kbManager: KBManager;
    knowledgePath: string;
    llmClient: { endpoint: string; apiKey: string; model: string };
  }) {
    this.config = opts.config;
    this.kbManager = opts.kbManager;
    this.knowledgePath = opts.knowledgePath;
    this.llmClient = opts.llmClient;
    // State file alongside LanceDB (dbPath parent)
    this.emailStatePath = path.join(homedir(), ".ark-kb", "email-state.json");
    this.state = { lastUid: 0, lastScan: 0, totalProcessed: 0, failed: [] };
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    if (!this.config.enabled) {
      console.log("[EmailIngester] Disabled — skipping");
      return;
    }

    // Check LLM availability
    if (!this.llmClient.endpoint || !this.llmClient.apiKey) {
      console.log("[EmailIngester] LLM not configured — email routing (KB selection) will be skipped");
    }

    // Load state
    this._loadState();

    // Ensure tmp directory
    const tmpDir = path.join(homedir(), ".ark-kb", "tmp-email");
    fs.mkdirSync(tmpDir, { recursive: true });

    // Dynamic import of imapflow
    try {
      const { ImapFlow } = await import("imapflow");
      this.ImapFlow = ImapFlow;
    } catch (err) {
      console.error("[EmailIngester] Failed to import imapflow. Run: npm install imapflow");
      return;
    }

    // Connect
    await this._connect();

    // Start scanning
    this.scanTimer = setInterval(() => {
      this.scan().catch(err => console.error("[EmailIngester] Scan error:", err.message));
    }, this.config.scanIntervalMs);

    console.log(`[EmailIngester] Started — scanning ${this.config.host} every ${this.config.scanIntervalMs}ms`);
  }

  // -------------------------------------------------------------------------
  // Scan emails
  // -------------------------------------------------------------------------

  async scan(): Promise<void> {
    if (!this.imapClient) {
      try {
        await this._connect();
      } catch (err: any) {
        console.error("[EmailIngester] IMAP connect failed:", err.message);
        return;
      }
    }

    try {
      const lock = await this.imapClient.getMailboxLock("INBOX");
      try {
        // Search for messages with UID > lastUid
        const query: any = {};
        if (this.state.lastUid > 0) {
          query.uid = { $gt: this.state.lastUid };
        }

        const messages = this.imapClient.scan({
          path: "INBOX",
          query,
          maxMessages: 100,
        });

        let count = 0;
        for await (const msg of messages) {
          const email = await this._parseEmail(msg);
          if (email.attachments.length === 0) {
            // Update lastUid even for non-attachment emails
            if (msg.uid > this.state.lastUid) {
              this.state.lastUid = msg.uid;
            }
            continue;
          }

          await this._processEmail(email);
          if (msg.uid > this.state.lastUid) {
            this.state.lastUid = msg.uid;
          }
          count++;
        }

        this.state.lastScan = Date.now();
        if (count > 0) {
          console.log(`[EmailIngester] Processed ${count} email(s) with attachments`);
        }
        this._saveState();
      } finally {
        lock.release();
      }
    } catch (err: any) {
      console.error("[EmailIngester] Scan error:", err.message);
    }
  }

  // -------------------------------------------------------------------------
  // Process a single email
  // -------------------------------------------------------------------------

  private async _processEmail(email: EmailMessage): Promise<void> {
    const kbNames = this.kbManager.getAllKBNames();
    if (kbNames.length === 0) {
      console.warn("[EmailIngester] No KBs available — skipping email:", email.subject);
      return;
    }

    // Determine target KB(s)
    let targetKBs: string[];
    try {
      targetKBs = await this.routeEmail(email.subject, email.body, email.attachments, kbNames);
    } catch (err: any) {
      console.error("[EmailIngester] routeEmail error:", err.message);
      targetKBs = [this.kbManager.getDefaultKBName() || kbNames[0]];
    }

    // Download attachments to temp dir
    const tmpDir = path.join(homedir(), ".ark-kb", "tmp-email");
    const downloadedPaths: string[] = [];

    for (const att of email.attachments) {
      let retries = 0;
      while (retries <= this.config.maxRetries) {
        try {
          const filePath = path.join(tmpDir, att.filename);
          fs.writeFileSync(filePath, att.data);
          downloadedPaths.push(filePath);
          break;
        } catch (err: any) {
          retries++;
          if (retries > this.config.maxRetries) {
            this._recordFailure(email.messageId, `Failed to write attachment ${att.filename}: ${err.message}`);
          } else {
            await this._sleep(1000 * retries);
          }
        }
      }
    }

    // Ingest each attachment into each matched KB
    for (const kbName of targetKBs) {
      const kbPath = path.join(this.knowledgePath, kbName);
      fs.mkdirSync(kbPath, { recursive: true });
      for (const filePath of downloadedPaths) {
        const destPath = path.join(kbPath, path.basename(filePath));
        // Copy file to KB folder if not already there (first KB gets the original, rest get copies)
        const alreadyCopied = targetKBs.indexOf(kbName) > 0 && fs.existsSync(filePath);
        const srcPath = alreadyCopied ? filePath : filePath;
        if (kbName !== targetKBs[0] || !fs.existsSync(destPath)) {
          fs.copyFileSync(srcPath, destPath);
        }
        let retries = 0;
        while (retries <= this.config.maxRetries) {
          try {
            await this.kbManager.ingestByPath(destPath);
            this.state.totalProcessed++;
            // Clean up temp file (only after first KB ingests; copies persist)
            if (targetKBs.indexOf(kbName) === 0) {
              try { fs.unlinkSync(filePath); } catch {}
            }
            break;
          } catch (err: any) {
            retries++;
            if (retries > this.config.maxRetries) {
              this._recordFailure(email.messageId, `Failed to ingest ${path.basename(destPath)}: ${err.message}`);
              try { fs.unlinkSync(destPath); } catch {}
            } else {
              await this._sleep(1000 * retries);
            }
          }
        }
      }
    }

    this._saveState();
  }

  /**
   * Route an email to the appropriate KB(s).
   * Stage 0: Regex match KB names in subject+body.
   * Stage 1: LLM analyzes subject+body to pick KB(s).
   * Stage 2: If stage 1 returns "none", analyze attachment content.
   */
  async routeEmail(
    subject: string,
    body: string,
    attachments: AttachmentInfo[],
    kbNames: string[],
  ): Promise<string[]> {
    if (kbNames.length === 1) {
      return kbNames;
    }

    const kbList = kbNames.join(", ");

    // Stage 0: Regex match KB names in subject+body
    const regexMatched: string[] = [];
    for (const kb of kbNames) {
      const escaped = kb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped, 'i');
      if (pattern.test(subject) || pattern.test(body)) {
        regexMatched.push(kb);
      }
    }
    if (regexMatched.length > 0) {
      console.log(`[EmailIngester] Regex matched "${subject}" → ${regexMatched.join(", ")}`);
      return regexMatched;
    }

    // Stage 1: LLM subject+body routing
    if (this.llmClient.endpoint && this.llmClient.apiKey) {
      try {
        const systemPrompt = `你是一个知识库路由助手。当前可用知识库：${kbList}。
请判断这封邮件适合放入哪些知识库。如果邮件涉及多个领域，可以返回多个知识库。
只回复 JSON: {"kbNames": ["知识库名1", "知识库名2"] 或 ["none"], "reason": "简短说明"}`;
        const userContent = `主题：${subject}\n正文：${body}`;
        const response = await this.askLLM(systemPrompt, userContent);
        const parsed = this._parseLLMJson(response);
        const matched = (parsed?.kbNames || []).filter((n: string) => n !== "none" && kbNames.includes(n));
        if (matched.length > 0) {
          console.log(`[EmailIngester] Stage1 LLM routed "${subject}" → ${matched.join(", ")}`);
          return matched;
        }
      } catch (err: any) {
        console.warn("[EmailIngester] Stage1 LLM failed:", err.message);
      }
    }

    // Stage 2: Analyze attachment content (also supports multi-KB)
    for (const att of attachments) {
      try {
        const matched = await this._routeAttachment(att, kbNames, kbList);
        if (matched.length > 0) return matched;
      } catch (err: any) {
        console.warn(`[EmailIngester] Attachment ${att.filename} routing failed:`, err.message);
      }
    }

    // Fallback: all default KB
    return [this.kbManager.getDefaultKBName() || kbNames[0]];
  }

  private async _routeAttachment(
    att: AttachmentInfo,
    kbNames: string[],
    kbList: string,
  ): Promise<string[]> {
    const ext = path.extname(att.filename).toLowerCase();
    const textExts = [".txt", ".md", ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"];
    const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
    const videoExts = [".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv"];

    if (textExts.includes(ext)) {
      // Stage 2a: Text/PDF content analysis
      const content = att.data.toString("utf-8").substring(0, 8000);
      if (!this.llmClient.endpoint || !this.llmClient.apiKey) return [];

      try {
        const systemPrompt = `当前可用知识库：${kbList}。请根据以下文档内容判断最适合放入哪些知识库。如果文档涉及多个领域，可以返回多个知识库。只回复 JSON: {"kbNames": ["知识库名1", "知识库名2"], "reason": "简短说明"}`;
        const response = await this.askLLM(systemPrompt, content);
        const parsed = this._parseLLMJson(response);
        const matched = (parsed?.kbNames || []).filter((n: string) => kbNames.includes(n));
        if (matched.length > 0) {
          console.log(`[EmailIngester] Stage2 text routed "${att.filename}" → ${matched.join(", ")}`);
          return matched;
        }
      } catch (err: any) {
        console.warn("[EmailIngester] Stage2 text LLM failed:", err.message);
      }
    } else if (imageExts.includes(ext)) {
      // Stage 2b: VLM image analysis
      if (!this.llmClient.endpoint || !this.llmClient.apiKey) return [];

      try {
        const base64 = att.data.toString("base64");
        const mimeType = this._mimeType(ext);
        const response = await this.askVLM(
          `当前可用知识库：${kbList}。请根据图片内容判断最适合放入哪些知识库。如果图片涉及多个领域，可以返回多个知识库。只回复 JSON: {"kbNames": ["知识库名1", "知识库名2"], "reason": "简短说明"}`,
          base64,
          mimeType,
        );
        const parsed = this._parseLLMJson(response);
        const matched = (parsed?.kbNames || []).filter((n: string) => kbNames.includes(n));
        if (matched.length > 0) {
          console.log(`[EmailIngester] Stage2 image routed "${att.filename}" → ${matched.join(", ")}`);
          return matched;
        }
      } catch (err: any) {
        console.warn("[EmailIngester] Stage2 image VLM failed:", err.message);
      }
    } else if (videoExts.includes(ext)) {
      // Stage 2c: Video — for now, route to default KB (full video analysis is expensive)
      // Could implement frame extraction + VLM here if needed
      console.log(`[EmailIngester] Video attachment "${att.filename}" → default KB (video analysis not yet implemented)`);
      return [this.kbManager.getDefaultKBName() || kbNames[0]];
    }

    return [];
  }

  // -------------------------------------------------------------------------
  // LLM / VLM helpers
  // -------------------------------------------------------------------------

  async askLLM(systemPrompt: string, userContent: string): Promise<string> {
    const { endpoint, apiKey, model } = this.llmClient;
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        max_tokens: 512,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM HTTP ${response.status}: ${await response.text()}`);
    }

    const data: any = await response.json();
    return data.choices?.[0]?.message?.content ?? "";
  }

  async askVLM(systemPrompt: string, imageBase64: string, mimeType = "image/jpeg"): Promise<string> {
    const { endpoint, apiKey, model } = this.llmClient;
    const dataUrl = `data:${mimeType};base64,${imageBase64}`;

    const body: any = {
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: systemPrompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 512,
      temperature: 0.1,
    };

    const response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`VLM HTTP ${response.status}: ${await response.text()}`);
    }

    const data: any = await response.json();
    return data.choices?.[0]?.message?.content ?? "";
  }

  private _parseLLMJson(text: string): { kbNames?: string[]; kbName?: string; reason?: string } | null {
    try {
      const cleaned = text.replace(/```json\n?|\n?```/g, "").trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        // 兼容旧格式：单 kbName 转成数组
        if (parsed.kbName && !parsed.kbNames) {
          parsed.kbNames = [parsed.kbName];
        }
        return parsed;
      }
    } catch {}
    return null;
  }

  // -------------------------------------------------------------------------
  // IMAP helpers
  // -------------------------------------------------------------------------

  private async _connect(): Promise<void> {
    if (this.ImapFlow === null) {
      throw new Error("imapflow not loaded");
    }

    this.imapClient = new this.ImapFlow({
      host: this.config.host,
      port: this.config.port,
      tls: this.config.tls,
      auth: {
        user: this.config.user,
        pass: this.config.password,
      },
      logger: {
        debug: () => {},
        info: () => {},
        warn: (msg: string) => console.warn(`[IMAP] ${msg}`),
        error: (msg: string) => console.error(`[IMAP] ${msg}`),
      },
    });

    await this.imapClient.connect();
    console.log(`[EmailIngester] Connected to ${this.config.host}`);
  }

  private async _parseEmail(msg: any): Promise<EmailMessage> {
    const envelope = msg.envelope ?? {};
    const subject = envelope.subject ?? "(no subject)";
    const messageId = envelope.messageId ?? String(msg.uid);

    // Get text body
    let body = "";
    try {
      const text = await msg.text();
      body = text ?? "";
    } catch {
      body = "";
    }

    // Get attachments
    const attachments: AttachmentInfo[] = [];
    try {
      if (msg.hasAttachments || (envelope.headers && Object.keys(envelope.headers).length > 0)) {
        // Fetch full message to access attachments
        const full = await msg.fullJson();
        if (full?.body?.attachments) {
          for (const att of full.body.attachments) {
            const filename = att.filename ?? `attachment_${attachments.length}`;
            const mimeType = att.contentType ?? "application/octet-stream";
            const data = Buffer.from(att.content ?? "", "base64");
            if (data.length > 0) {
              attachments.push({ filename, mimeType, data });
            }
          }
        }
      }
    } catch (err: any) {
      console.warn(`[EmailIngester] Failed to parse attachments for UID ${msg.uid}:`, err.message);
    }

    return { messageId, subject, body, attachments };
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  private _loadState(): void {
    try {
      if (fs.existsSync(this.emailStatePath)) {
        const raw = fs.readFileSync(this.emailStatePath, "utf-8");
        const loaded = JSON.parse(raw) as EmailState;
        this.state = {
          lastUid: loaded.lastUid ?? 0,
          lastScan: loaded.lastScan ?? 0,
          totalProcessed: loaded.totalProcessed ?? 0,
          failed: loaded.failed ?? [],
        };
      }
    } catch (err: any) {
      console.warn("[EmailIngester] Failed to load state:", err.message);
    }
  }

  private _saveState(): void {
    try {
      const dir = path.dirname(this.emailStatePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.emailStatePath, JSON.stringify(this.state, null, 2));
    } catch (err: any) {
      console.error("[EmailIngester] Failed to save state:", err.message);
    }
  }

  private _recordFailure(messageId: string, error: string): void {
    const existing = this.state.failed.findIndex(f => f.messageId === messageId);
    if (existing >= 0) {
      this.state.failed[existing].retries++;
      this.state.failed[existing].error = error;
      this.state.failed[existing].timestamp = Date.now();
    } else {
      this.state.failed.push({
        messageId,
        error,
        retries: 1,
        timestamp: Date.now(),
      });
    }
    // Keep only last 100 failures
    if (this.state.failed.length > 100) {
      this.state.failed = this.state.failed.slice(-100);
    }
    this._saveState();
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.imapClient) {
      try {
        await this.imapClient.logout();
      } catch {}
      this.imapClient = null;
    }
    console.log("[EmailIngester] Shutdown complete");
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private _mimeType(ext: string): string {
    const map: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
    };
    return map[ext] ?? "application/octet-stream";
  }

  /** Get current state for status reporting */
  getState(): EmailState {
    return { ...this.state };
  }
}
