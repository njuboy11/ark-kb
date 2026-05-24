/**
 * Ark KB — Email Ingester
 * Monitors an IMAP mailbox and auto-ingests email attachments into knowledge bases.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
// ============================================================================
// EmailIngester
// ============================================================================
export class EmailIngester {
    config;
    kbManager;
    knowledgePath;
    llmClient;
    emailStatePath;
    state;
    scanTimer = null;
    imapClient = null;
    ImapFlow = null;
    constructor(opts) {
        this.config = opts.config;
        this.kbManager = opts.kbManager;
        this.knowledgePath = opts.knowledgePath;
        this.llmClient = opts.llmClient;
        // State file alongside LanceDB (dbPath parent)
        this.emailStatePath = path.join(homedir(), ".ark-kb", "email-state.json");
        this.state = { lastProcessedTime: new Date(0).toISOString(), lastScan: 0, totalProcessed: 0, failed: [], permanentFailures: [] };
    }
    // -------------------------------------------------------------------------
    // Init
    // -------------------------------------------------------------------------
    async init() {
        if (this._initialized) {
            console.log("[EmailIngester] Already initialized — skipping");
            return;
        }
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
        }
        catch (err) {
            console.error("[EmailIngester] Failed to import imapflow. Run: npm install imapflow");
            return;
        }
        // Connect
        await this._connect();
        // Start scanning — do an initial scan immediately, then every interval
        this.scan().catch(err => console.error("[EmailIngester] Initial scan error:", err.message));
        this.scanTimer = setInterval(() => {
            this.scan().catch(err => console.error("[EmailIngester] Scan error:", err.message));
        }, this.config.scanIntervalMs);
        console.log(`[EmailIngester] Started — scanning ${this.config.host} every ${this.config.scanIntervalMs}ms`);
    }
    // -------------------------------------------------------------------------
    // Scan emails
    // -------------------------------------------------------------------------
    async scan() {
        // Mutex: skip if previous scan is still in progress
        if (this._scanning) {
            return;
        }
        this._scanning = true;
        if (!this.imapClient) {
            try {
                await this._connect();
            }
            catch (err) {
                console.error("[EmailIngester] IMAP connect failed:", err.message);
                return;
            }
        }
        try {
            const lock = await this.imapClient.getMailboxLock("INBOX");
            try {
                // Step 1: Use lastProcessedTime for forward scanning.
                // Failed emails are retried separately by UID below.
                const retryableFailed = this.state.failed.filter(f => f.retries < 2);
                const sinceTime = this.state.lastProcessedTime;
                // Step 2: Fetch failed list emails with retries < 2 separately
                if (retryableFailed.length > 0) {
                    const failedUids = retryableFailed.map(f => f.uid);
                    console.log(`[EmailIngester] Re-fetching failed emails: UIDs ${failedUids.join(", ")}`);
                    const failedSeqNums = await this.imapClient.search({ uid: failedUids });
                    if (Array.isArray(failedSeqNums) && failedSeqNums.length > 0) {
                        for (const seq of failedSeqNums) {
                            if (seq > 1000)
                                break;
                            console.log(`[EmailIngester] Fetching failed seq ${seq}…`);
                            const msg = await this.imapClient.fetchOne(seq, {
                                uid: true,
                                source: true,
                                envelope: true,
                                bodyStructure: true,
                                internalDate: true,
                            });
                            if (!msg)
                                continue;
                            const email = await this._parseEmail(msg);
                            const failedEntry = this.state.failed.find(f => f.uid === email.uid);
                            if (!failedEntry)
                                continue;
                            // Skip if this UID has permanently failed (auth error etc.)
                            if (this.state.permanentFailures && this.state.permanentFailures.includes(email.uid)) {
                                console.log(`[EmailIngester] Skipping UID ${email.uid} — permanent failure, removing from retry list`);
                                this.state.failed = this.state.failed.filter(f => f.uid !== email.uid);
                                this._saveState();
                                continue;
                            }
                            try {
                                await this._processEmail(email);
                                // Success — remove from failed list
                                this.state.failed = this.state.failed.filter(f => f.uid !== email.uid);
                                console.log(`[EmailIngester] Successfully reprocessed UID ${email.uid}`);
                            }
                            catch (err) {
                                console.error(`[EmailIngester] Re-process failed for UID ${email.uid}:`, err.message);
                                this._recordFailure(email.uid, email.messageId, err.message, email.internalDate);
                            }
                        }
                    }
                }
                // Step 3: Regular scan since lastProcessedTime
                const criteria = { since: new Date(sinceTime) };
                const seqNums = await this.imapClient.search(criteria);
                const matches = Array.isArray(seqNums) ? seqNums : [];
                console.log(`[EmailIngester] search criteria:`, JSON.stringify(criteria), `→ ${matches.length} matches`);
                let count = 0;
                let maxProcessedInternalDate = sinceTime;
                for (const seq of matches) {
                    if (seq > 1000)
                        break;
                    console.log(`[EmailIngester] Fetching seq ${seq}…`);
                    const msg = await this.imapClient.fetchOne(seq, {
                        uid: true,
                        source: true,
                        envelope: true,
                        bodyStructure: true,
                        internalDate: true,
                    });
                    if (!msg) {
                        console.log(`[EmailIngester] seq ${seq} returned null`);
                        continue;
                    }
                    const email = await this._parseEmail(msg);
                    console.log(`[EmailIngester] seq ${seq} UID=${email.uid} subj="${email.subject}" att=${email.attachments.length}`);
                    // Skip if in failed list with retries >= 2
                    const failedEntry = this.state.failed.find(f => f.uid === email.uid);
                    if (failedEntry && failedEntry.retries >= 2) {
                        console.log(`[EmailIngester] Skipping UID ${email.uid} — permanently failed`);
                        continue;
                    }
                    // Skip if uid is in permanent failures (auth error etc.)
                    if (this.state.permanentFailures && this.state.permanentFailures.includes(email.uid)) {
                        console.log(`[EmailIngester] Skipping UID ${email.uid} — permanent auth failure`);
                        // Also remove from failed list if present
                        this.state.failed = this.state.failed.filter(f => f.uid !== email.uid);
                        continue;
                    }
                    // Skip emails without attachments (no-op, don't bump timestamp)
                    if (email.attachments.length === 0)
                        continue;
                    // Always advance the timestamp cursor past this email
                    // so it won't be re-scanned. Failed emails are retried by UID separately.
                    if (email.internalDate > maxProcessedInternalDate) {
                        maxProcessedInternalDate = email.internalDate;
                    }
                    try {
                        await this._processEmail(email);
                        // Success — remove from failed list
                        this.state.failed = this.state.failed.filter(f => f.uid !== email.uid);
                        count++;
                    }
                    catch (err) {
                        console.error(`[EmailIngester] Failed to process UID ${email.uid}:`, err.message);
                        this._recordFailure(email.uid, email.messageId, err.message, email.internalDate);
                    }
                }
                // Always advance the timestamp to the latest scanned email, even if
                // some failed. Individual retries are handled by UID in the next scan.
                // Always advance timestamp past the scan window
                // If no email had a later internalDate, advance to now
                if (maxProcessedInternalDate !== sinceTime) {
                    this.state.lastProcessedTime = maxProcessedInternalDate;
                } else {
                    // No newer emails — bump to current time so next scan doesn't re-process
                    this.state.lastProcessedTime = new Date().toISOString();
                    console.log(`[EmailIngester] All emails older than ${sinceTime} — advancing timestamp to now`);
                }
                // If nothing was processed → keep old timestamp → all emails retried
                this.state.lastScan = Date.now();
                if (count > 0) {
                    console.log(`[EmailIngester] Processed ${count} email(s) with attachments`);
                }
                this._saveState();
            }
            finally {
                lock.release();
            }
        }
        catch (err) {
            console.error("[EmailIngester] Scan error:", err.message);
        }
        finally {
            this._scanning = false;
        }
    }
    // -------------------------------------------------------------------------
    // Process a single email
    // -------------------------------------------------------------------------
    async _processEmail(email) {
        const kbNames = this.kbManager.getAllKBNames();
        if (kbNames.length === 0) {
            console.warn("[EmailIngester] No KBs available — skipping email:", email.subject);
            return;
        }
        // Determine target KB(s)
        let targetKBs;
        try {
            targetKBs = await this.routeEmail(email.subject, email.body, email.attachments, kbNames);
            if (targetKBs.length === 0) {
                console.log(`[EmailIngester] Skipping "${email.subject}" — LLM returned ignore`);
                return;
            }
        }
        catch (err) {
            console.error("[EmailIngester] routeEmail error:", err.message);
            targetKBs = [this.kbManager.getDefaultKBName() || kbNames[0]];
        }
        // Download attachments to temp dir
        const tmpDir = path.join(homedir(), ".ark-kb", "tmp-email");
        const downloadedPaths = [];
        for (const att of email.attachments) {
            let retries = 0;
            while (retries <= this.config.maxRetries) {
                try {
                    const filePath = path.join(tmpDir, att.filename);
                    fs.writeFileSync(filePath, att.data);
                    downloadedPaths.push(filePath);
                    break;
                }
                catch (err) {
                    retries++;
                    if (retries > this.config.maxRetries) {
                        this._recordFailure(email.uid, email.messageId, `Failed to write attachment ${att.filename}: ${err.message}`, email.internalDate);
                    }
                    else {
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
                            try {
                                fs.unlinkSync(filePath);
                            }
                            catch { }
                        }
                        break;
                    }
                    catch (err) {
                        // Auth errors (401) = permanent failure, don't retry
                        const isAuthError = err.message && (
                            err.message.includes("401") ||
                            err.message.includes("user authenticate failed") ||
                            err.message.includes("A0202")
                        );
                        if (isAuthError) {
                            console.error(`[EmailIngester] Auth failure for UID ${email.uid}: ${err.message} — marking permanent`);
                            this._recordPermanentFailure(email.uid);
                            // Don't delete dest file — hash-dedup on next scan will skip it
                            break;
                        }
                        else if (retries >= this.config.maxRetries) {
                            this._recordFailure(email.uid, email.messageId, `Failed to ingest ${path.basename(destPath)}: ${err.message}`, email.internalDate);
                            try {
                                fs.unlinkSync(destPath);
                            }
                            catch { }
                        }
                        else {
                            retries++;
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
    async routeEmail(subject, body, attachments, kbNames) {
        if (kbNames.length === 1) {
            return kbNames;
        }
        const kbList = kbNames.join(", ");
        // Stage 0: Regex match KB names in subject+body
        const regexMatched = [];
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
如果这封邮件明显是垃圾邮件、广告邮件、推销邮件或无关邮件，请返回 "ignore" 而不是 "none"。
只回复 JSON: {"kbNames": ["知识库名1", "知识库名2"] 或 ["none"] 或 ["ignore"], "reason": "简短说明"}`;
                const userContent = `主题：${subject}\n正文：${body}`;
                const response = await this.askLLM(systemPrompt, userContent);
                const parsed = this._parseLLMJson(response);
                const names = parsed?.kbNames || [];
                // Handle "ignore" — skip this email entirely (spam/ad)
                if (names.length === 1 && names[0] === "ignore") {
                    console.log(`[EmailIngester] Stage1 LLM skipped (spam/ad): "${subject}"`);
                    return []; // Empty array → caller will skip
                }
                const matched = names.filter((n) => n !== "none" && n !== "ignore" && kbNames.includes(n));
                if (matched.length > 0) {
                    console.log(`[EmailIngester] Stage1 LLM routed "${subject}" → ${matched.join(", ")}`);
                    return matched;
                }
            }
            catch (err) {
                console.warn("[EmailIngester] Stage1 LLM failed:", err.message);
            }
        }
        // Stage 2: Analyze attachment content (also supports multi-KB)
        for (const att of attachments) {
            try {
                const matched = await this._routeAttachment(att, kbNames, kbList);
                if (matched.length > 0)
                    return matched;
            }
            catch (err) {
                console.warn(`[EmailIngester] Attachment ${att.filename} routing failed:`, err.message);
            }
        }
        // Fallback: all default KB
        return [this.kbManager.getDefaultKBName() || kbNames[0]];
    }
    async _routeAttachment(att, kbNames, kbList) {
        const ext = path.extname(att.filename).toLowerCase();
        const textExts = [".txt", ".md", ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"];
        const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
        const videoExts = [".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv"];
        if (textExts.includes(ext)) {
            // Stage 2a: Text/PDF content analysis
            const content = att.data.toString("utf-8").substring(0, 8000);
            if (!this.llmClient.endpoint || !this.llmClient.apiKey)
                return [];
            try {
                const systemPrompt = `当前可用知识库：${kbList}。请根据以下文档内容判断最适合放入哪些知识库。如果文档涉及多个领域，可以返回多个知识库。只回复 JSON: {"kbNames": ["知识库名1", "知识库名2"], "reason": "简短说明"}`;
                const response = await this.askLLM(systemPrompt, content);
                const parsed = this._parseLLMJson(response);
                const matched = (parsed?.kbNames || []).filter((n) => kbNames.includes(n));
                if (matched.length > 0) {
                    console.log(`[EmailIngester] Stage2 text routed "${att.filename}" → ${matched.join(", ")}`);
                    return matched;
                }
            }
            catch (err) {
                console.warn("[EmailIngester] Stage2 text LLM failed:", err.message);
            }
        }
        else if (imageExts.includes(ext)) {
            // Stage 2b: VLM image analysis
            if (!this.llmClient.endpoint || !this.llmClient.apiKey)
                return [];
            try {
                const base64 = att.data.toString("base64");
                const mimeType = this._mimeType(ext);
                const response = await this.askVLM(`当前可用知识库：${kbList}。请根据图片内容判断最适合放入哪些知识库。如果图片涉及多个领域，可以返回多个知识库。只回复 JSON: {"kbNames": ["知识库名1", "知识库名2"], "reason": "简短说明"}`, base64, mimeType);
                const parsed = this._parseLLMJson(response);
                const matched = (parsed?.kbNames || []).filter((n) => kbNames.includes(n));
                if (matched.length > 0) {
                    console.log(`[EmailIngester] Stage2 image routed "${att.filename}" → ${matched.join(", ")}`);
                    return matched;
                }
            }
            catch (err) {
                console.warn("[EmailIngester] Stage2 image VLM failed:", err.message);
            }
        }
        else if (videoExts.includes(ext)) {
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
    async askLLM(systemPrompt, userContent) {
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
        const data = await response.json();
        return data.choices?.[0]?.message?.content ?? "";
    }
    async askVLM(systemPrompt, imageBase64, mimeType = "image/jpeg") {
        const { endpoint, apiKey, model } = this.llmClient;
        const dataUrl = `data:${mimeType};base64,${imageBase64}`;
        const body = {
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
        const data = await response.json();
        return data.choices?.[0]?.message?.content ?? "";
    }
    _parseLLMJson(text) {
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
        }
        catch { }
        return null;
    }
    // -------------------------------------------------------------------------
    // IMAP helpers
    // -------------------------------------------------------------------------
    async _connect() {
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
                debug: () => { },
                info: () => { },
                warn: () => { },
                error: (msg) => console.error(`[EmailIngester] IMAP error: ${msg}`),
            },
        });
        await this.imapClient.connect();
        console.log(`[EmailIngester] Connected to ${this.config.host}`);
    }
    async _parseEmail(msg) {
        const envelope = msg.envelope ?? {};
        const subject = envelope.subject ?? "(no subject)";
        const messageId = envelope.messageId ?? String(msg.uid);
        const uid = msg.uid ?? 0;
        // Get INTERNALDATE and convert to ISO string
        const internalDate = msg.internalDate
            ? (typeof msg.internalDate === "string" ? msg.internalDate : new Date(msg.internalDate).toISOString())
            : new Date().toISOString();
        // Get text body
        let body = "";
        try {
            const text = await msg.text();
            body = text ?? "";
        }
        catch {
            body = "";
        }
        // Get attachments — use mailparser to parse raw source
        const attachments = [];
        try {
            if (msg.source) {
                const { simpleParser } = await import("mailparser");
                const parsed = await simpleParser(msg.source);
                for (const att of parsed.attachments || []) {
                    // Skip inline images (email signatures, embeds) — only real attachments
                    const disposition = att.contentDisposition ?? "attachment";
                    if (disposition === "inline")
                        continue;
                    const filename = att.filename ?? `attachment_${attachments.length}`;
                    const mimeType = att.contentType ?? "application/octet-stream";
                    const data = att.content instanceof Buffer ? att.content : Buffer.from(att.content || "");
                    if (data.length > 0) {
                        attachments.push({ filename, mimeType, data });
                    }
                }
            }
        }
        catch (err) {
            console.warn(`[EmailIngester] Failed to parse attachments for UID ${uid}:`, err.message);
        }
        return { messageId, subject, body, attachments, internalDate, uid };
    }
    // -------------------------------------------------------------------------
    // State management
    // -------------------------------------------------------------------------
    _loadState() {
        try {
            if (fs.existsSync(this.emailStatePath)) {
                const raw = fs.readFileSync(this.emailStatePath, "utf-8");
                const loaded = JSON.parse(raw);
                this.state = {
                    lastProcessedTime: loaded.lastProcessedTime ?? new Date(0).toISOString(),
                    lastScan: loaded.lastScan ?? 0,
                    totalProcessed: loaded.totalProcessed ?? 0,
                    failed: loaded.failed ?? [],
                    permanentFailures: loaded.permanentFailures ?? [],
                };
            }
        }
        catch (err) {
            console.warn("[EmailIngester] Failed to load state:", err.message);
        }
    }
    _saveState() {
        try {
            const dir = path.dirname(this.emailStatePath);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.emailStatePath, JSON.stringify(this.state, null, 2));
        }
        catch (err) {
            console.error("[EmailIngester] Failed to save state:", err.message);
        }
    }
    _recordFailure(uid, messageId, error, arrivedAt) {
        const existing = this.state.failed.find(f => f.uid === uid);
        if (existing) {
            existing.retries = (existing.retries || 0) + 1;
            existing.error = error;
        }
        else {
            this.state.failed.push({ uid, messageId, error, retries: 1, arrivedAt });
        }
        // Clean up permanently failed (retries >= 2)
        this.state.failed = this.state.failed.filter(f => f.retries < 2);
        this._saveState();
    }
    _recordPermanentFailure(uid) {
        if (!this.state.permanentFailures) {
            this.state.permanentFailures = [];
        }
        if (!this.state.permanentFailures.includes(uid)) {
            this.state.permanentFailures.push(uid);
        }
        // Also remove from retryable failed list
        this.state.failed = this.state.failed.filter(f => f.uid !== uid);
        this._saveState();
    }
    // -------------------------------------------------------------------------
    // Shutdown
    // -------------------------------------------------------------------------
    async shutdown() {
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
            this.scanTimer = null;
        }
        if (this.imapClient) {
            try {
                await this.imapClient.logout();
            }
            catch { }
            this.imapClient = null;
        }
        console.log("[EmailIngester] Shutdown complete");
    }
    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    _mimeType(ext) {
        const map = {
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
    getState() {
        return { ...this.state };
    }
}
//# sourceMappingURL=email-ingester.js.map