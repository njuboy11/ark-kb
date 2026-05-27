# 🏛️ Ark KB

> **Ark Knowledge Base** — Drop files in a folder. Everything else is automatic.

A personal knowledge base for AI assistants. Powered by **LanceDB** + **MinerU** + **Multimodal Embedding**. Auto-detects file types, auto-parses, auto-chunks, auto-embeds, auto-indexes. 90+ file formats, 14-file codebase, ~7,000 lines.

---

## ✨ What It Does

```
┌─────────────────────────────────────────────────────┐
│              Your Knowledge Folder                   │
│                                                     │
│  📄 report.pdf      📊 data.xlsx     📽️ deck.pptx   │
│  📝 notes.md        🖼️ photo.jpg     🎬 demo.mp4    │
│  📄 contract.docx   📧 email attachments             │
│                                                     │
│         ↓  fs.watch  (real-time)                     │
│         ↓  detectFileKind  (90+ formats)             │
│         ↓  complexity detection (Office XML)          │
│         ↓  MinerU / VLM / direct extract             │
│         ↓  chunkText  (paragraph / fixed / sentence) │
│         ↓  embed  (vectorize)                        │
│         ↓  upsert to LanceDB                         │
└─────────────────────────────────────────────────────┘

You ask: "What was the Q2 revenue forecast?"
   ↓
I search: semantic hybrid search → find the .xlsx chunk → show results
```

---

## 📂 Supported Formats (90+)

### 📝 Text (46 formats)
`.md` `.txt` `.csv` `.html` `.htm` `.json` `.yaml` `.yml` `.xml` `.toml`

`.py` `.js` `.ts` `.jsx` `.tsx` `.java` `.c` `.cpp` `.h` `.go` `.rs` `.rb` `.php` `.sh` `.bash` `.sql` `.r` `.scala` `.lua`

`.css` `.scss` `.less` `.vue` `.swift` `.kt` `.dart`

`.log` `.conf` `.cfg` `.ini` `.env` `.tex` `.rst` `.org` `.adoc`

### 🏢 Office (6 formats)

| Format | Simple | Complex | Binary |
|--------|--------|---------|--------|
| **Word** | `.docx` (text only) → `pipeline` | `.docx` (formulas/images) → `vlm` | `.doc` → `vlm` |
| **Excel** | `.xlsx` (data only) → `pipeline` | `.xlsx` (charts/formulas) → `vlm` | `.xls` → `vlm` |
| **PPT** | `.pptx` (text only) → `pipeline` | `.pptx` (charts/animations) → `vlm` | `.ppt` → `vlm` |

> **Complexity detection**: For `.docx` / `.xlsx` / `.pptx`, the plugin reads the ZIP-internal XML to detect formulas, charts, images, pivot tables, animations, etc. (10 markers each). Complex files automatically route to `vlm` model for higher accuracy.

### 📄 PDF
`.pdf` → MinerU vlm (formulas, tables, images all extracted)

### 🌐 HTML
`.html` `.htm` → MinerU `MinerU-HTML` model (structured extraction)

### 🖼️ Images (17 formats)
`.png` `.jpg` `.jpeg` `.jfif` `.webp` `.gif` `.bmp` `.svg` `.tiff` `.tif` `.ico` `.heic` `.heif` `.raw` `.cr2` `.nef` `.arw`

→ VLM summary → text embedding (configurable to multimodal direct embedding)

### 🎬 Video (11 formats)
`.mp4` `.mov` `.avi` `.mkv` `.webm` `.wmv` `.flv` `.m4v` `.3gp` `.ogv` `.ts`

→ VLM frame analysis → summary → text embedding

### 📧 Email Ingestion
IMAP-based (imapflow), auto-polls inbox, extracts `.txt` `.md` `.pdf` `.doc` `.docx` `.ppt` `.pptx` `.xls` `.xlsx` `.html` `.htm` `.png` `.jpg` `.jpeg` `.gif` `.svg` `.webp` `.bmp` attachments.

---

## 🔧 How It Works

### Ingestion Pipeline

```
file dropped / email received
    ↓
detectFileKind() → FileKind
    ↓
├─ text / code   → direct chunking
├─ pdf           → MinerU API v4 (precision parsing)
├─ docx/pptx/xlsx → isComplex() → pipeline | vlm → MinerU
├─ doc/ppt/xls   → MinerU vlm (binary)
├─ html          → MinerU MinerU-HTML
├─ image         → VLM describe → text embed (or multimodal)
├─ video         → VLM frame → summary → text embed
    ↓
chunkText() (paragraph / fixed / sentence strategy)
    ↓
embedder.embed() → vectors
    ↓
store.upsert() → LanceDB
```

### Chunking Strategies
| Strategy | Behavior |
|----------|----------|
| `paragraph` | Split on blank lines, merge up to maxTokens |
| `fixed` | Fixed-size window with overlap |
| `sentence` | Split on sentence-ending punctuation |

### Hash Deduplication
SHA256-based content dedup with hash-level locking to prevent concurrent ingestion of identical files with different names.

### UID-based Email Tracking
Persists `lastProcessedUID` to avoid re-processing emails across restarts. Failed emails go to retry queue tracked by UID.

---

## 🛠️ OpenClaw Tools

| Tool | Description |
|------|-------------|
| `kb_search` | Hybrid semantic + keyword search with optional fileType filter |
| `kb_ingest` | Manually trigger indexing of a file or all files |
| `kb_remove` | Remove indexed chunks for a given source file |
| `kb_status` | Show total chunks, indexed files, config summary |

---

## 📐 Architecture

```
┌─────────────────────────────────────┐
│          Storage Layer               │
│  /path/to/knowledge/ (filesystem)    │
│  ~/.ark-kb/* (state, LanceDB)        │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│          Index Layer                 │
│  LanceDB (embedded, zero-ops)        │
│  IVF-PQ ANN search, millisecond       │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│          Retrieval Layer             │
│  Hybrid: vector + BM25               │
│  Optional: reranking (BGE-m3)        │
│  fileType filter, pagination         │
└─────────────────────────────────────┘
```

---

## 🔩 Technical Stack

| Component | Technology |
|---|---|
| Vector DB | **LanceDB** (embedded, zero-ops) |
| PDF/Office parsing | **MinerU API v4** (precision parsing + complexity routing) |
| Embedding | Configurable (MiniMax / Qwen / etc.) |
| Image understanding | **VLM** (MiniMax-VL / Qwen-VL) |
| Video summarization | **VLM** frame analysis |
| File watching | **fs.watch** + debounce |
| Email | **imapflow** (IMAP, configurable polling) |
| Search algo | **IVF-PQ ANN** + **BM25** keyword |
| Chunking | paragraph / fixed / sentence strategies |
| Dedup | SHA256 content hash + hash-level locking |
| Runtime | Node.js / TypeScript |

---

## 🚀 Quick Start

```bash
# 1. Install
npm install ark-kb

# 2. Configure (plugin-config.json)
{
  "knowledgePath": "/path/to/knowledge",
  "embedding": { "model": "qwen/Qwen3-VL-Embedding-8B" },
  "pdfParser": {
    "api": "mineru",
    "endpoint": "https://mineru.net/api/v4/extract/task",
    "apiKey": "your-mineru-token"
  }
}

# 3. Drop files into /path/to/knowledge
#    → Auto-indexed. No action needed.

# 4. Search via OpenClaw tool
kb_search(query="Q2 revenue forecast", fileType="xlsx")
```

---

## 📝 License

AGPL v3 © [njuboy11](https://github.com/njuboy11)

> **A small ark that holds your world.** 🏛️
