# 🏛️ Ark KB

> **Ark Knowledge Base** — A personal knowledge base powered by LanceDB + Multimodal Embedding.

**Drop your files in a folder. That's it.**

---

## 📖 Overview

Ark KB is a knowledge base plugin built for AI assistants. The philosophy is dead simple:

**You get one folder. You put stuff in it. Everything else is automatic.**

```
┌─────────────────────────────────────────┐
│          Your Knowledge Folder           │
│                                          │
│  📄 product-manual.pdf  🖼️ arch.png     │
│  📄 technical-design.md 🖼️ login-ui.png │
│  📄 Q2-report.docx      🖼️ dashboard.png│
│                                          │
│         ↓ fs.watch (auto detect)          │
│         ↓ auto parse (add / modify / del) │
│         ↓ auto embed (Qwen3-VL-8B)        │
│         ↓ auto index (LanceDB)            │
│         ↓ auto sync                       │
└─────────────────────────────────────────┘

You say: "Find me that login UI screenshot"
   ↓
I search: semantic match → image path → show it to you
```

---

## ✨ Features

### 🔌 Zero config, filesystem-as-database
No manual imports. No folder hierarchy to maintain. No directory trees to remember. Designate a folder — **drop files in to auto-index**, delete to auto-remove, modify to auto-sync.

### 🧠 Native multimodal semantic search
Powered by **Qwen3-VL-Embedding-8B** (4096 dimensions). Text and images live in **the same vector space**:

```
You type: "Dark gradient login screen with logo on top-right"
   ↓            Same vector space
Image has: An actual login screenshot

→ Search with text, find images. Natively. ✅
→ No need to describe images manually before searching
```

### 📄 Multi-format auto-parsing

| Type | Status | Pipeline |
|---|---|---|
| **PDF** | ✅ | MinerU → text + images |
| **Markdown** | ✅ | Direct chunking, preserves image references |
| **Plain text** | ✅ | Direct chunking |
| **Images (png/jpg/webp)** | ✅ | Standalone visual vectors |
| **Office (docx/xlsx)** | 🔜 | Planned |

### 👁️ Text-image association, WYSIWYG
PDFs parsed by MinerU retain the original text-image relationship. Search results carry image references.

```
Search: "JWT auth flow"
Hit chunk: Token expired... use refresh_token...
Linked image: arch-diagram.png → shown inline
```

### 🚀 Clean architecture, separation of concerns

```
Storage layer (filesystem)
  └── /path/to/knowledge/     ← You only care about this folder
        ├── product-plan.pdf
        ├── arch-diagram.png
        └── technical-doc.md

Index layer (LanceDB)
  └── collection: knowledge_base
        ├── chunk_text: "Token expires after..."
        ├── embedding: [4096-dim vector]
        ├── source_path: "technical-doc.md"
        ├── images: ["arch-diagram.png"]
        └── ...

Retrieval layer (multimodal + reranker)
  └── Qwen3-VL-8B → vectorization
  └── LanceDB ANNS → approximate nearest neighbor search
  └── BGE-m3 → reranking (optional)
```

---

## 🔧 Technical Stack

| Component | Technology | Notes |
|---|---|---|
| Vector database | **LanceDB** | Embedded, zero-ops, single-binary |
| Multimodal embedding | **Qwen3-VL-Embedding-8B** | 4096-dim, unified text/image space |
| Search algo | **IVF-PQ (LanceDB native)** | Approximate NN, millisecond latency |
| Reranking (opt) | **BGE-m3** | Cross-encoder precision filter |
| File watching | **Node.js fs.watch (inotify)** | Real-time add/change/delete detection |
| PDF parsing | **MinerU** | High-precision PDF→Markdown + image extraction |

## 🗺️ Roadmap

- [x] `v0.1` — Project scaffold + GitHub repo
- [ ] `v0.2` — Core: file watcher + auto-indexing + semantic search
- [ ] `v0.3` — PDF auto-parsing (MinerU integration)
- [ ] `v0.4` — Image multimodal indexing
- [ ] `v0.5` — Reranker support
- [ ] `v0.6` — OpenClaw plugin registration (kb_search / kb_ingest tools)
- [ ] `v0.7` — Knowledge management CLI/TUI
- [ ] `v1.0` — Stable release + Office document support

---

## 🚀 Quick Start (planned)

```bash
# 1. Set your knowledge base directory
export ARK_KB_PATH=/path/to/your/knowledge

# 2. Start (file watcher begins automatically)
npx ark-kb start

# 3. Drop files into /path/to/your/knowledge
# Auto-indexed, no action needed

# 4. Search
npx ark-kb search "login page design"
```

---

## 🤝 Who is it for

- **AI users** — Give your AI assistant a private knowledge base to query
- **Knowledge workers** — Unified search across PDFs, screenshots, notes
- **Designers / PMs** — Design drafts, prototypes, requirement docs, all searchable
- **Technical writers** — Architecture docs, diagrams, code snippets, one-stop retrieval

---

## 📝 License

MIT © [njuboy11](https://github.com/njuboy11)

---

> **A small ark that holds your world.** 🏛️
