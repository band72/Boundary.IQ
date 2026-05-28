import { useState, useEffect } from 'react';

// ─── Section data ──────────────────────────────────────────────────────────────
const SECTIONS = [
  { id: 'overview',  icon: '🗺️',  label: 'Overview'           },
  { id: 'traverse',  icon: '📐',  label: 'Traverse Compute'   },
  { id: 'plat',      icon: '🛰️',  label: 'Plat Extraction'    },
  { id: 'writer',    icon: '✍️',  label: 'Legal Writer'       },
  { id: 'batch',     icon: '📦',  label: 'Batch Deed'         },
  { id: 'dashboard', icon: '📊',  label: 'Dashboard'          },
  { id: 'settings',  icon: '⚙️',  label: 'Settings & Models'  },
  { id: 'formats',   icon: '📄',  label: 'File Formats'       },
  { id: 'faq',       icon: '❓',  label: 'FAQ'                },
];

// ─── Individual section content ───────────────────────────────────────────────

function SectionOverview() {
  return (
    <div>
      <Hero
        icon="⬡"
        title="Boundary.IQ"
        subtitle="Survey Intelligence Platform"
        color="#3d7fff"
      />
      <p style={styles.body}>
        Boundary.IQ automates the full deed-to-map workflow for land surveyors, title researchers,
        and GIS professionals. It combines a high-accuracy coordinate geometry (COGO) engine with
        Google Gemini 3.5 Flash / local Ollama vision models to convert historical metes-and-bounds
        deed documents into closed, survey-grade vector polygons — in seconds.
      </p>

      <Grid cols={2}>
        <FeatureCard icon="📐" title="Traverse Compute" color="#3d7fff">
          Manual course entry with live closure checking, Compass Rule adjustment, and interactive map output.
        </FeatureCard>
        <FeatureCard icon="🛰️" title="Plat Extraction" color="#00d4a8">
          Upload a PDF or image of a plat or deed. AI reads metes-and-bounds courses and returns JSON instantly.
        </FeatureCard>
        <FeatureCard icon="✍️" title="Legal Writer" color="#a855f7">
          Generate professional, registry-ready legal descriptions from a solved traverse in seconds.
        </FeatureCard>
        <FeatureCard icon="📦" title="Batch Deed Processor" color="#f5a623">
          Process entire folders of deed PDFs/DOCs simultaneously, with an automatic 7-stage repair pipeline.
        </FeatureCard>
      </Grid>

      <Callout type="tip">
        <strong>Quickstart:</strong> Go to <strong>Plat Extraction</strong>, drop a PDF deed, hit Extract — then jump to
        Traverse Compute to view the closed map and precision ratio.
      </Callout>

      <Section title="Core Technology Stack">
        <Row label="COGO Engine" value="RCS Coordinate Geometry — Forward projection, Compass Rule, Shoelace area" />
        <Row label="AI Vision" value="Google Gemini 3.5 Flash (cloud) | Ollama gemma4/qwen2.5/deepseek (local)" />
        <Row label="Repair Pipeline" value="7-stage agentic system: Bowtie, Scrivener, Compass, Meander, Multi-agent" />
        <Row label="Export" value="DXF, GeoJSON, legal description TXT, print blueprint PDF" />
      </Section>
    </div>
  );
}

function SectionTraverse() {
  return (
    <div>
      <PageTitle icon="📐" title="Traverse Compute" subtitle="Manual COGO entry and closure analysis" />
      <p style={styles.body}>
        The Traverse tab is the core geometric engine. Enter any sequence of metes-and-bounds courses
        (lines and curves) and the engine instantly projects coordinate stations, computes closure error,
        calculates area, and optionally applies the Compass Rule (Bowditch) adjustment.
      </p>

      <Section title="Step-by-Step Workflow">
        <Step n={1} title="Set the Point of Beginning (POB)">
          Enter a Northing and Easting coordinate for the starting point. Default is (5000, 5000).
          For real-world projects use your control point coordinates.
        </Step>
        <Step n={2} title="Add Courses">
          Click <Mono>+ Add Course</Mono> for each boundary leg. Choose <Mono>Line</Mono> or <Mono>Curve</Mono>.
          <ul style={styles.ul}>
            <li><strong>Line:</strong> Enter bearing (e.g. <Mono>N45°30'15"E</Mono>) and distance in feet or meters.</li>
            <li><strong>Curve:</strong> Enter chord bearing, arc length, radius, and direction (Left/Right).</li>
          </ul>
        </Step>
        <Step n={3} title="Read the Closure Report">
          The engine shows <strong>Linear Error of Closure</strong> and <strong>Precision Ratio</strong> (e.g. <Mono>1:10,000</Mono>).
          Survey grade typically requires 1:10,000 or better.
        </Step>
        <Step n={4} title="Apply Compass Rule (optional)">
          Toggle <Mono>Apply Compass Rule</Mono> to distribute the misclosure error proportionally
          across all courses. This forces perfect closure for mapping and DXF export.
        </Step>
        <Step n={5} title="Export">
          Export a <Mono>.dxf</Mono> file for CAD, or print a 11"×8.5" blueprint sheet with
          the parcel map, course table, and title block.
        </Step>
      </Section>

      <Section title="Bearing Format Reference">
        <Row label="Cardinal" value="N, S, E, W  or  NORTH, SOUTH" />
        <Row label="Quadrant DMS" value={`N45°30\u201915"E  |  S89°41\u201910"W`} />
        <Row label="Decimal degrees" value="N45.5042E  (auto-converted)" />
        <Row label="Azimuth" value="045.5042  (0–360, auto-detected)" />
        <Row label="Unknown distance" value="Leave blank — engine solves as gap-close leg" />
      </Section>

      <Callout type="info">
        Bearings are parsed with fuzzy tolerance — <Mono>N 45 30 15 E</Mono>, <Mono>N45-30-15E</Mono>,
        and <Mono>N45°30'15"E</Mono> all parse identically. The parser flags LOW-confidence readings so
        the AI repair pipeline knows where to focus re-extraction.
      </Callout>

      <Section title="Precision Ratio Thresholds">
        <Row label="≥ 1:20,000" value="✓ First-order monument survey" color="#00d4a8" />
        <Row label="≥ 1:10,000" value="✓ Survey-grade boundary deed" color="#00d4a8" />
        <Row label="≥ 1:5,000" value="⚠ Acceptable for historical deeds" color="#f5a623" />
        <Row label="< 1:1,000" value="✗ Likely extraction error — run AI repair" color="#ff4d6d" />
      </Section>
    </div>
  );
}

function SectionPlat() {
  return (
    <div>
      <PageTitle icon="🛰️" title="Plat Extraction" subtitle="AI-powered OCR for deed documents" />
      <p style={styles.body}>
        Upload any scanned plat image or deed PDF. Gemini 3.5 Flash (or a local Ollama vision model)
        reads the metes-and-bounds legal language and returns structured JSON courses that load directly
        into the Traverse tab for closure computation.
      </p>

      <Section title="Supported File Types">
        <Row label="PDF" value=".pdf — multi-page deeds, recorded plats, subdivision covenants" />
        <Row label="Images" value=".jpg .jpeg .png .tiff .webp — scanned pages, photo captures" />
        <Row label="Word" value=".doc .docx — typed deed descriptions (auto-converted to PDF)" />
        <Row label="Max size" value="51 MB (adjustable in Settings)" />
      </Section>

      <Section title="Step-by-Step Workflow">
        <Step n={1} title="Choose your AI Model">
          In Settings → AI Model Provider, select Gemini (cloud, best accuracy) or a local Ollama model.
          Gemini requires an API key. Ollama runs entirely on your machine.
        </Step>
        <Step n={2} title="Upload the Document">
          Drag and drop or click the upload zone. The file is read client-side and sent to the AI.
        </Step>
        <Step n={3} title="Review Extracted Courses">
          The AI returns a table of bearings, distances, curve parameters, and any special calls
          (monument references, water boundaries, right-of-way calls). Review for obvious OCR errors.
        </Step>
        <Step n={4} title="Send to Traverse">
          Click <Mono>Send to Traverse ▶</Mono> to load courses into the COGO engine and compute closure.
        </Step>
      </Section>

      <Callout type="tip">
        For scanned images, <strong>higher DPI = better accuracy</strong>. 300 DPI is the minimum recommended.
        If extraction quality is poor, try the <Mono>AI Reprocess</Mono> button — it sends a targeted
        correction prompt focused on the specific courses that failed closure.
      </Callout>

      <Callout type="info">
        <strong>Multi-parcel documents:</strong> If the deed contains descriptions for Parcel A and Parcel B
        (e.g., a combined deed with separate boundaries), the AI automatically fans them out into tabs.
      </Callout>
    </div>
  );
}

function SectionWriter() {
  return (
    <div>
      <PageTitle icon="✍️" title="Legal Description Writer" subtitle="Generate registry-ready legal text from coordinates" />
      <p style={styles.body}>
        Once you have a solved traverse, the Legal Writer converts the coordinate geometry into a
        professional, survey-grade metes-and-bounds description. The output follows industry-standard
        language used by title companies and county recorders.
      </p>

      <Section title="Step-by-Step Workflow">
        <Step n={1} title="Load Solved Courses">
          Either solve in Traverse Compute and click <Mono>Send to Writer</Mono>, or paste raw
          JSON course data directly into the writer's input field.
        </Step>
        <Step n={2} title="Set Parcel Metadata">
          Fill in the Point of Beginning description (e.g., "the Northeast corner of Lot 4"),
          county, state, grantor/grantee names, and any monument calls.
        </Step>
        <Step n={3} title="Generate Description">
          Click <Mono>Generate Legal Description</Mono>. The AI drafts the full text, formatting
          bearings and distances in legal notation (e.g., "North 45 degrees 30 minutes 15 seconds East,
          208.42 feet").
        </Step>
        <Step n={4} title="Review and Export">
          Edit inline if needed, then copy to clipboard or export as a <Mono>.txt</Mono> file.
        </Step>
      </Section>

      <Callout type="info">
        The writer uses the <strong>Hierarchy of Evidence</strong> principle: monuments over bearings,
        bearings over distances, plat calls over deed calls. Ambiguous distances are flagged with a note.
      </Callout>
    </div>
  );
}

function SectionBatch() {
  return (
    <div>
      <PageTitle icon="📦" title="Batch Deed Processor" subtitle="Process entire folders automatically" />
      <p style={styles.body}>
        The Batch Deed Processor scans a folder on your local machine, processes every deed file through
        the 7-stage repair pipeline simultaneously, and outputs closed polygon maps, legal descriptions,
        and DXF files. Up to 20 files per batch, configurable concurrent agents.
      </p>

      <Section title="Step-by-Step Workflow">
        <Step n={1} title="Specify the Folder">
          Enter the full path to your deed folder (e.g., <Mono>/home/user/Deeds/2024</Mono>) and
          click <Mono>Scan Folder</Mono>. The server lists all compatible files.
        </Step>
        <Step n={2} title="Review File List">
          The file list shows names, sizes, and any cached results from previous runs.
          Files with a green ✅ have a saved solution. Click <Mono>⚡ Run Batch</Mono> to process.
        </Step>
        <Step n={3} title="Watch Processing">
          Each file goes through the 7-stage repair pipeline. Progress updates stream live.
          Files that pass closure show their precision ratio. Failures show the stage where they stopped.
        </Step>
        <Step n={4} title="Inspect Results">
          Click any file tab to see the split-view: extracted courses on the left, traverse
          closure report + interactive map on the right.
        </Step>
        <Step n={5} title="Retry Failures">
          Click <Mono>↻ Retry Failed</Mono> to re-run only the files that didn't achieve closure,
          using a more aggressive repair strategy.
        </Step>
        <Step n={6} title="Export">
          Download individual DXF files, a full JSON batch export, or all legal descriptions as .txt.
        </Step>
      </Section>

      <Section title="7-Stage Repair Pipeline">
        <Step n="0" title="Direct Extraction">AI reads document and attempts direct closure. Fastest path.</Step>
        <Step n="1" title="Bowtie Flip">Tests all 4-bit quadrant bearing inversions (N↔S, E↔W) to resolve self-intersecting polygons.</Step>
        <Step n="2" title="Multi-Model Ensemble">Runs a second AI extraction and picks the candidate with the lower closure error.</Step>
        <Step n="3" title="Compass Rule Force-Close">Applies Bowditch adjustment to a nearly-closed traverse (error &lt; 10 ft).</Step>
        <Step n="3.5" title="Scrivener Error Solver">Tests systematic transcription errors: dropped digits, decimal shifts, transposed numerals.</Step>
        <Step n="3.7" title="Shape Correction">Applies rectangular alignment and backtrack detection for box-shaped parcels.</Step>
        <Step n="4" title="LOT/BLOCK &amp; PLSS Lookup">For lot-and-block or PLSS descriptions: queries BLM Cadastral, county ArcGIS, or GLO APIs.</Step>
        <Step n="5" title="Hierarchical Agent System">Full multi-agent turn loop: Extractor → COGO → Legal Surveyor → Confidence Scorer.</Step>
      </Section>

      <Section title="Trust Score">
        <p style={{ ...styles.body, marginBottom: '0.5rem' }}>
          After a successful closure, the Confidence Scorer evaluates the result for plausibility:
        </p>
        <Row label="HIGH (≥80)" value="✓ Geometry is well-formed and bearing distribution is normal" color="#00d4a8" />
        <Row label="MEDIUM (55–79)" value="⚠ Some round-number bearings or narrow aspect ratio" color="#f5a623" />
        <Row label="LOW (&lt;55)" value="✗ Degenerate shape or systematic OCR substitution suspected" color="#ff4d6d" />
      </Section>

      <Callout type="tip">
        Enable <strong>Auto-Output Files</strong> in Settings to automatically write DXF + legal description
        files to a timestamped subfolder inside the source deed directory after every batch.
      </Callout>
    </div>
  );
}

function SectionDashboard() {
  return (
    <div>
      <PageTitle icon="📊" title="Dashboard" subtitle="System telemetry and batch history" />
      <p style={styles.body}>
        The Dashboard shows real-time statistics from the SQLite diagnostics database: total deeds
        processed, success rate, average precision, stage usage distribution, and the full batch run history.
      </p>
      <Section title="Key Metrics">
        <Row label="Total Processed" value="All deeds run through the pipeline (cached + live)" />
        <Row label="Success Rate" value="Percentage achieving passing closure (error &lt; 0.30 ft or 1:10,000+)" />
        <Row label="Stage Distribution" value="Bar chart of which repair stage solved each deed" />
        <Row label="Avg Linear Error" value="Mean misclosure across all solved deeds in feet" />
        <Row label="Batch Run History" value="Every batch run with per-file results, expandable rows" />
      </Section>
      <Callout type="info">
        Click any batch row in the history table to expand the per-file result detail.
        Click <Mono>↻ Refresh</Mono> after running a new batch to update stats.
      </Callout>
    </div>
  );
}

function SectionSettings() {
  return (
    <div>
      <PageTitle icon="⚙️" title="Settings & AI Models" subtitle="Configure providers, concurrency, and output" />

      <Section title="AI Model Provider">
        <p style={styles.body}>Three provider types are supported:</p>
        <Row label="☁️ Gemini (Cloud)" value="Google Gemini 3.5 Flash. Best accuracy for complex scanned plats. Requires GEMINI_API_KEY in server/.env" />
        <Row label="🖥️ Ollama (Local)" value="Run models on your own machine. No API key, no data leaves your network. Models: gemma4:e2b, qwen2.5-coder:7b, deepseek-coder:6.7b" />
        <Row label="🔌 OpenAI-Compat" value="Any /v1/chat/completions endpoint: LM Studio, llama.cpp, vLLM. Enter the base URL." />
      </Section>

      <Section title="Starting Ollama">
        <Step n={1} title="Auto-start (built-in)">The server automatically attempts to start Ollama when it boots. Check the terminal for <Mono>✓ Ollama online</Mono>.</Step>
        <Step n={2} title="Manual start">Run <Mono>ollama serve</Mono> in a terminal, or click the <Mono>▶ Start Ollama</Mono> button in Settings.</Step>
        <Step n={3} title="Pull new models"><Mono>ollama pull gemma4</Mono> | <Mono>ollama pull llava</Mono> | <Mono>ollama pull qwen2.5-coder:7b</Mono></Step>
      </Section>

      <Section title="Concurrency Settings">
        <Row label="Concurrent Agents" value="Number of parallel AI extraction workers per batch (default: 5)" />
        <Row label="Parallel Batch Streams" value="Number of simultaneous 20-file batches (Turbo Mode — paid API tier)" />
        <Row label="Max File Size" value="Upper limit for scanned deed PDFs (default: 51 MB)" />
      </Section>

      <Section title="Environment Variables (server/.env)">
        <Row label="GEMINI_API_KEY" value="Your Google Gemini API key" />
        <Row label="OLLAMA_URL" value="Ollama base URL (default: http://127.0.0.1:11434)" />
        <Row label="OLLAMA_PATH" value="Full path to the ollama binary if not on system PATH" />
        <Row label="PORT" value="API server port (default: 5050)" />
      </Section>

      <Callout type="tip">
        Use <Mono>bash start.sh</Mono> from the project root to launch both the API server and Vite
        dev client in one command with the correct Node version auto-detected via NVM.
      </Callout>
    </div>
  );
}

function SectionFormats() {
  return (
    <div>
      <PageTitle icon="📄" title="File Formats" subtitle="Supported inputs and outputs" />

      <Section title="Input Formats">
        <Row label=".pdf" value="Scanned plats, recorded deeds, title documents, subdivision covenants" />
        <Row label=".jpg .png .tiff .webp" value="Photographed deed pages, scanned images" />
        <Row label=".doc .docx" value="Typed deed descriptions in Word format (auto-converted via LibreOffice)" />
        <Row label="JSON array" value="Raw course array (paste directly into Traverse or Writer)" />
      </Section>

      <Section title="Output Formats">
        <Row label=".dxf" value="AutoCAD Drawing Exchange Format. Compatible with AutoCAD, QGIS, Civil 3D, BricsCAD." />
        <Row label=".txt" value="Plain-text legal description. Ready for title commitment or deed attachment." />
        <Row label=".json" value="Full batch result export: courses, traverse data, trust score, stage used." />
        <Row label="Blueprint PDF" value={`11×8.5" printable survey sheet: map + course table + title block (via browser print).`} />
      </Section>

      <Section title="DXF Layer Structure">
        <Row label="BOUNDARY" value="Closed polygon of the parcel boundary (adjusted stations)" />
        <Row label="BOUNDARY_UNADJ" value="Unadjusted raw traverse before Compass Rule" />
        <Row label="ANNOTATIONS" value="Course labels: bearing + distance at segment midpoints" />
        <Row label="POB" value="Point of Beginning marker" />
        <Row label="AREA_TEXT" value="Parcel area and precision text block" />
      </Section>
    </div>
  );
}

function SectionFAQ() {
  return (
    <div>
      <PageTitle icon="❓" title="FAQ" subtitle="Frequently asked questions" />

      <FAQ q="Why does Ollama return errors on vision calls?">
        Ollama's native <Mono>/api/chat</Mono> endpoint requires <Mono>content</Mono> as a plain string
        and <Mono>images</Mono> as a separate array — not an OpenAI-style content-block array. This was fixed
        in v1.0.1. If you're on an older version, update and restart the server.
      </FAQ>

      <FAQ q="The batch processor always used gemma4:e2b even when I selected another model.">
        This was a bug (fixed in v1.0.1) — the batch route was forcing <Mono>gemma4:e2b</Mono> regardless
        of the active Settings model. Restart the server and the selection in Settings is now honoured.
      </FAQ>

      <FAQ q="My deed has a 1:300 precision ratio — is the extraction wrong?">
        Not necessarily. Some historical deeds (pre-1920) were measured with chains and compasses with inherent
        error. A ratio below 1:1,000 usually means one of: (1) a transcription error in a single course,
        (2) a quadrant bearing flip, or (3) missing courses. Use <Mono>AI Reprocess</Mono> or run through
        the Batch retry flow to trigger the full repair pipeline.
      </FAQ>

      <FAQ q="Can I use Boundary.IQ without an internet connection?">
        Yes — select any <strong>Ollama</strong> model in Settings. All AI inference runs locally.
        The COGO engine, DXF export, and legal writer all run on your local server with no cloud calls.
        The BLM/GLO lookup (Stage 4 for PLSS descriptions) does require internet.
      </FAQ>

      <FAQ q="What is a 'PLSS' description?">
        Public Land Survey System — the U.S. federal land grid. Descriptions look like:
        "SE¼ of NW¼ of Section 12, Township 3 North, Range 5 East". Boundary.IQ resolves these by
        querying the BLM GLO REST API for the actual section polygon and applying Shoelace area.
      </FAQ>

      <FAQ q="How do I add a new Ollama model?">
        Run <Mono>ollama pull &lt;modelname&gt;</Mono> in a terminal, then click <Mono>↻ Refresh</Mono>
        in Settings → AI Model Provider. The new model appears in the selector automatically.
      </FAQ>

      <FAQ q="Where is my data stored?">
        All data stays local. The SQLite diagnostics database is at <Mono>server/diagnostics.db</Mono>.
        Extracted text cache files are in <Mono>_extracted/</Mono> next to your deed files.
        Nothing is sent to external servers unless you use the Gemini (cloud) provider.
      </FAQ>

      <FAQ q="Can I start the app without knowing about NVM?">
        Yes — use <Mono>bash start.sh</Mono> from the project root. It auto-detects Node v20 via NVM
        and starts both the API server and Vite client, then shuts them both down on Ctrl+C.
      </FAQ>
    </div>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function Hero({ icon, title, subtitle, color }) {
  return (
    <div style={{
      background: `linear-gradient(135deg, ${color}18 0%, transparent 100%)`,
      border: `1px solid ${color}33`,
      borderRadius: 12,
      padding: '1.5rem',
      marginBottom: '1.5rem',
      display: 'flex',
      alignItems: 'center',
      gap: '1.25rem',
    }}>
      <div style={{
        width: 56, height: 56,
        background: `linear-gradient(135deg, ${color} 0%, ${color}aa 100%)`,
        borderRadius: 12,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '1.8rem',
        boxShadow: `0 0 24px ${color}44`,
        flexShrink: 0,
      }}>{icon}</div>
      <div>
        <div style={{ fontSize: '1.4rem', fontWeight: 800, letterSpacing: '-0.02em', color: '#e8eeff' }}>{title}</div>
        <div style={{ fontSize: '0.85rem', color: '#8899bb', marginTop: '0.2rem' }}>{subtitle}</div>
      </div>
    </div>
  );
}

function PageTitle({ icon, title, subtitle }) {
  return (
    <div style={{ marginBottom: '1.5rem', paddingBottom: '1rem', borderBottom: '1px solid #1f2e4d' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.3rem' }}>
        <span style={{ fontSize: '1.5rem' }}>{icon}</span>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 800, color: '#e8eeff', letterSpacing: '-0.02em', margin: 0 }}>{title}</h2>
      </div>
      {subtitle && <p style={{ margin: 0, fontSize: '0.82rem', color: '#8899bb', paddingLeft: '2.25rem' }}>{subtitle}</p>}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <div style={{
        fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.1em', color: '#4a5a7a', marginBottom: '0.6rem',
        paddingBottom: '0.4rem', borderBottom: '1px solid #1f2e4d',
      }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>{children}</div>
    </div>
  );
}

function Step({ n, title, children }) {
  return (
    <div style={{ display: 'flex', gap: '0.85rem', alignItems: 'flex-start', padding: '0.6rem 0' }}>
      <div style={{
        width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
        background: 'linear-gradient(135deg, #3d7fff, #00d4a8)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '0.65rem', fontWeight: 700, color: '#fff',
        boxShadow: '0 0 8px rgba(61,127,255,0.4)',
      }}>{n}</div>
      <div>
        <div style={{ fontWeight: 600, color: '#e8eeff', fontSize: '0.875rem', marginBottom: '0.2rem' }}>{title}</div>
        {children && <div style={{ fontSize: '0.8rem', color: '#8899bb', lineHeight: 1.6 }}>{children}</div>}
      </div>
    </div>
  );
}

function Row({ label, value, color }) {
  return (
    <div style={{
      display: 'flex', gap: '1rem', alignItems: 'flex-start',
      padding: '0.45rem 0.75rem',
      background: '#141e35',
      borderRadius: 6,
      fontSize: '0.8rem',
    }}>
      <span style={{
        flexShrink: 0, width: 160, color: '#8899bb', fontWeight: 500,
        fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem',
      }}>{label}</span>
      <span style={{ color: color || '#e8eeff', lineHeight: 1.5 }}>{value}</span>
    </div>
  );
}

function Grid({ cols, children }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
      gap: '0.75rem',
      marginBottom: '1.5rem',
    }}>{children}</div>
  );
}

function FeatureCard({ icon, title, color, children }) {
  return (
    <div style={{
      background: `${color}0d`,
      border: `1px solid ${color}33`,
      borderRadius: 10,
      padding: '1rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
        <span style={{ fontSize: '1.1rem' }}>{icon}</span>
        <span style={{ fontWeight: 700, color, fontSize: '0.875rem' }}>{title}</span>
      </div>
      <p style={{ margin: 0, fontSize: '0.78rem', color: '#8899bb', lineHeight: 1.55 }}>{children}</p>
    </div>
  );
}

function Callout({ type, children }) {
  const meta = {
    tip:  { color: '#00d4a8', bg: 'rgba(0,212,168,0.06)',  border: 'rgba(0,212,168,0.25)',  icon: '💡' },
    info: { color: '#3d7fff', bg: 'rgba(61,127,255,0.06)', border: 'rgba(61,127,255,0.25)', icon: 'ℹ️' },
    warn: { color: '#f5a623', bg: 'rgba(245,166,35,0.06)', border: 'rgba(245,166,35,0.25)', icon: '⚠️' },
  }[type] || meta.info;
  return (
    <div style={{
      background: meta.bg, border: `1px solid ${meta.border}`, borderRadius: 8,
      padding: '0.85rem 1rem', marginBottom: '1.25rem',
      display: 'flex', gap: '0.65rem', alignItems: 'flex-start',
      fontSize: '0.82rem', lineHeight: 1.6, color: '#c8d8ff',
    }}>
      <span style={{ flexShrink: 0, fontSize: '1rem' }}>{meta.icon}</span>
      <span>{children}</span>
    </div>
  );
}

function Mono({ children }) {
  return (
    <code style={{
      fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78em',
      background: 'rgba(61,127,255,0.12)', color: '#a8c4ff',
      padding: '1px 5px', borderRadius: 3,
    }}>{children}</code>
  );
}

function FAQ({ q, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{
      borderBottom: '1px solid #1f2e4d',
      marginBottom: '0.25rem',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', textAlign: 'left', background: 'none', border: 'none',
          padding: '0.85rem 0', cursor: 'pointer',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          gap: '1rem',
        }}
      >
        <span style={{ fontWeight: 600, color: '#e8eeff', fontSize: '0.875rem' }}>{q}</span>
        <span style={{
          color: '#3d7fff', fontSize: '1.1rem', flexShrink: 0,
          transition: 'transform 0.2s',
          transform: open ? 'rotate(45deg)' : 'none',
        }}>+</span>
      </button>
      {open && (
        <div style={{
          padding: '0 0 0.85rem 0',
          fontSize: '0.82rem', color: '#8899bb', lineHeight: 1.65,
          animation: 'slideDown 0.15s ease',
        }}>{children}</div>
      )}
    </div>
  );
}

const styles = {
  body: { fontSize: '0.875rem', color: '#8899bb', lineHeight: 1.7, marginBottom: '1.25rem' },
  ul: { paddingLeft: '1.25rem', marginTop: '0.4rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' },
};

// ─── Section renderer map ─────────────────────────────────────────────────────
const SECTION_COMPONENTS = {
  overview:  SectionOverview,
  traverse:  SectionTraverse,
  plat:      SectionPlat,
  writer:    SectionWriter,
  batch:     SectionBatch,
  dashboard: SectionDashboard,
  settings:  SectionSettings,
  formats:   SectionFormats,
  faq:       SectionFAQ,
};

// ─── Main Modal ───────────────────────────────────────────────────────────────
export default function HelpModal({ onClose }) {
  const [activeSection, setActiveSection] = useState('overview');

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const ActiveComponent = SECTION_COMPONENTS[activeSection] || SectionOverview;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(5, 8, 18, 0.85)',
        backdropFilter: 'blur(12px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '2rem',
        animation: 'fadeInHelp 0.18s ease',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <style>{`
        @keyframes fadeInHelp { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideUpHelp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideDown { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      <div style={{
        width: '100%', maxWidth: 980,
        height: 'min(88vh, 760px)',
        background: '#0f1729',
        border: '1px solid #1f2e4d',
        borderRadius: 18,
        boxShadow: '0 32px 80px rgba(0,0,0,0.7), 0 0 60px rgba(61,127,255,0.08)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        animation: 'slideUpHelp 0.22s ease',
      }}>

        {/* ── Modal header ─────────────────────────────────────────────── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '1rem 1.5rem',
          borderBottom: '1px solid #1f2e4d',
          background: '#090e1a',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{
              width: 32, height: 32,
              background: 'linear-gradient(135deg, #3d7fff, #00d4a8)',
              borderRadius: 8,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '1rem', boxShadow: '0 0 14px rgba(61,127,255,0.4)',
            }}>📖</div>
            <div>
              <div style={{ fontWeight: 800, color: '#e8eeff', fontSize: '1rem', letterSpacing: '-0.01em' }}>
                Boundary.IQ Documentation
              </div>
              <div style={{ fontSize: '0.7rem', color: '#4a5a7a' }}>
                Workflow guide | Use cases | User manual
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'rgba(255,255,255,0.05)', border: '1px solid #1f2e4d',
              borderRadius: 8, color: '#8899bb', cursor: 'pointer',
              width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '1rem', transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,77,109,0.12)'; e.currentTarget.style.color = '#ff4d6d'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#8899bb'; }}
            title="Close (Esc)"
          >✕</button>
        </div>

        {/* ── Body: sidebar + content ───────────────────────────────────── */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* Sidebar nav */}
          <nav style={{
            width: 200, flexShrink: 0,
            background: '#090e1a',
            borderRight: '1px solid #1f2e4d',
            padding: '0.75rem 0',
            overflowY: 'auto',
          }}>
            {SECTIONS.map(s => {
              const active = activeSection === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveSection(s.id)}
                  style={{
                    width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: '0.6rem',
                    padding: '0.6rem 1rem',
                    background: active ? 'rgba(61,127,255,0.1)' : 'none',
                    color: active ? '#3d7fff' : '#8899bb',
                    fontWeight: active ? 600 : 400,
                    fontSize: '0.82rem',
                    fontFamily: 'Inter, sans-serif',
                    borderLeft: active ? '3px solid #3d7fff' : '3px solid transparent',
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'none'; }}
                >
                  <span style={{ fontSize: '0.95rem', width: 20, textAlign: 'center' }}>{s.icon}</span>
                  {s.label}
                </button>
              );
            })}
          </nav>

          {/* Content area */}
          <div style={{
            flex: 1, overflowY: 'auto',
            padding: '1.75rem 2rem',
          }}>
            <ActiveComponent />
          </div>
        </div>

        {/* ── Footer ───────────────────────────────────────────────────── */}
        <div style={{
          borderTop: '1px solid #1f2e4d',
          padding: '0.6rem 1.5rem',
          background: '#090e1a',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: '0.7rem', color: '#4a5a7a' }}>
            Boundary.IQ | Survey Intelligence Platform | BETA v1.0
          </span>
          <span style={{ fontSize: '0.7rem', color: '#4a5a7a' }}>
            Press <kbd style={{ background: '#141e35', border: '1px solid #1f2e4d', borderRadius: 4, padding: '1px 5px', fontFamily: 'JetBrains Mono, monospace' }}>Esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}
