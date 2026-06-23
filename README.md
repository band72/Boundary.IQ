# Boundary.IQ — Survey Intelligence Platform

> **Automatically resolves 95%+ of historical deed closures — in seconds.**

Boundary.IQ is a professional survey computing, legal description processing, and geometric mapping platform for title companies, surveyors, and land attorneys. It bridges the gap between historical scanned deeds and digital precision.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-v20+-brightgreen)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-19-61dafb)](https://react.dev/)

---

## 🗺️ What It Does

Boundary.IQ reads a scanned PDF deed or plat, extracts the metes-and-bounds callouts using vision AI (Gemini or local Ollama), computes the coordinate geometry, closes the traverse using the Compass Rule, and produces a professional legal description — all automatically.

| Problem | Boundary.IQ Solution |
|---|---|
| Surveyor spends 30–90 min closing one deed manually | Automated closure in < 60 seconds |
| Scanned deeds have OCR errors (J→3, O→0, smashed bearings) | Multi-layer OCR repair pipeline |
| LLM extractions fail on unusual deed formats | 6-stage self-healing agent with automatic retry |
| Title company needs 500 deeds/month processed | Batch processor handles 20 files in parallel |

---

## ✨ Core Features

1. **📐 Traverse Compute (COGO Engine)** — Manual or auto entry of coordinate geometry courses. Computes progressive stations, polygon closure, perimeter, area, and applies the Compass Rule (Bowditch) adjustment.

2. **🛰️ AI Deed Extraction** — Uses Gemini Cloud or local Ollama models to extract metes-and-bounds courses from scanned PDFs. Supports multi-parcel deeds, curve data, PLSS descriptions, and title commitment formatting.

3. **🔧 Self-Healing Repair Pipeline** — A 6-stage agent system (`surveyorAgent` → `extractionAgent` → `cogoAgent` → Scrivener repair → PLSS resolver → meander detection) that automatically diagnoses and corrects extraction failures.

4. **📦 Batch Processor** — Processes entire folders of deed PDFs end-to-end: OCR → extraction → closure → map → legal description → DXF export → combined PDF summary.

5. **✍️ Legal Description Writer** — Translates computed coordinate courses into survey-grade legal descriptions ready for land registry filing.

6. **🗺️ Interactive Boundary Map** — Real-time SVG/Canvas map showing the computed traverse, closure vector, and parcel geometry with export to DXF (AutoCAD).

---

## ⚡ Quick Start

### Prerequisites
- **Node.js v20+** (server + React client)
- **Ollama** (for local inference) — `curl -fsSL https://ollama.com/install.sh | sh`
  - Pull the extraction model: `ollama pull gemma3:4b`
- OR a **Google Gemini API key** for cloud inference

### 1. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Required for Gemini Cloud inference (get a key at https://aistudio.google.com/)
GEMINI_API_KEY=your-key-here

# Optional: restrict file browser to these root paths (semicolon-separated)
# BOUNDARY_SCAN_ROOTS=/home/you/Deeds;/mnt/nas/surveys

# Optional: change the default port
# PORT=5050
```

### 2. Start the API Server

```bash
cd server
npm install
npm run dev
```

The server starts at `http://localhost:5050`. Ollama is auto-started if installed.

### 3. Start the React Client

```bash
cd client
npm install
npm run dev
```

Open **`http://localhost:5174`** in your browser.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│  React / Vite Frontend  (glassmorphic dark UI)          │
│  TraverseTab · BatchDeedTab · DashboardTab · SettingsTab│
└──────────────────────┬──────────────────────────────────┘
                       │ REST API  (:5050)
┌──────────────────────▼──────────────────────────────────┐
│  Express + Node.js API Server                           │
│  ├── /api/folderscan  — Batch processing pipeline       │
│  ├── /api/deed        — Single-file deed solver         │
│  ├── /api/traverse    — COGO geometry engine            │
│  ├── /api/writer      — Legal description generator     │
│  ├── /api/dxf         — DXF CAD export                 │
│  └── /api/diagnostics — Session logs, stats, dashboard  │
│                                                         │
│  Services:                                              │
│  ├── Scripting/                                         │
│  │   ├── agentSystem.js — 6-stage self-healing agent    │
│  │   ├── deedTextSolver.js— LLM extraction + repair     │
│  │   └── traverse.js    — COGO engine & traverse math   │
│  ├── geminiVision.js  — Gemini / OpenAI-compat adapter  │
│  ├── ollamaVision.js  — Local Ollama vision adapter     │
│  └── diagnosticsDb.js — SQLite session tracking (WAL)   │
└──────────┬────────────────────────┬────────────────────┘
           │                        │
    ┌──────▼──────┐         ┌───────▼──────┐
    │  Ollama     │         │  Gemini API  │
    │  (local)    │         │  (cloud)     │
    │  gemma3:4b  │         │  2.5-flash   │
    └─────────────┘         └──────────────┘
```

---

## 📊 Performance

Sample run on 102 historical deed PDFs (Regency Title training corpus):

| Metric | Value |
|---|---|
| Files processed | 102 |
| Auto-PASS (no human intervention) | 82 (80%) |
| After repair pipeline | 97+ (95%+) |
| Average time per deed | ~45 seconds (Gemini) / ~3 min (Ollama local) |
| Best precision ratio achieved | 1:1,047,000 |

---

## 🧪 Testing

```bash
# Unit tests: COGO math, Scrivener repair, bearing parser
cd server
node test_headless_riddle.js

# Integration tests: full REST API endpoints
node test_server_headless.js
```

---

## 📁 Project Structure

```
boundary.iq/
├── client/              # React 19 + Vite frontend
│   └── src/
│       ├── components/  # Tab UIs (BatchDeedTab, TraverseTab, etc.)
│       └── hooks/       # useLocalStorage, useStatsRefresh, useToast
├── server/              # Node.js + Express API
│   ├── routes/          # Express route handlers
│   ├── services/        # Business logic (COGO, LLM, DB)
│   └── scripts/         # Batch runner, repair loop
└── .env.example         # Environment variable template
```

---

## 🔒 Security

- Passwords hashed with PBKDF2-SHA512 (310,000 iterations, NIST SP 800-132)
- Session tokens are cryptographically random 256-bit values
- Auth endpoints rate-limited (10 requests per 15 min per IP)
- HTTP security headers via `helmet`
- File browser restricted to `BOUNDARY_SCAN_ROOTS` (directory traversal protected)
- Google OAuth tokens cryptographically verified (not decoded client-side)

---

## 📄 License

[MIT](LICENSE) — © 2026 Boundary.IQ
