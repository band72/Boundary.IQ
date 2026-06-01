import { useState, useRef, useEffect } from 'react';
import TraverseMap from './TraverseMap';
import PrintBlueprint from './PrintBlueprint';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useStatsRefresh } from '../hooks/useStatsRefresh.jsx';
import { API } from '../config';
import FolderBrowserModal from './FolderBrowserModal';

export default function BatchDeedTab() {
  const { triggerStatsRefresh } = useStatsRefresh();
  const [files, setFiles]       = useState([]);     // File[]
  const [drag, setDrag]         = useState(false);
  const [pobN]         = useLocalStorage('boundaryiq_batch_pobn', '5000.00');
  const [pobE]         = useLocalStorage('boundaryiq_batch_pobe', '5000.00');
  const [county]     = useLocalStorage('boundaryiq_batch_county', '');
  const [stateVal] = useLocalStorage('boundaryiq_batch_state', '');
  const [concurrentAgents]      = useLocalStorage('boundaryiq_concurrent_agents', 5);

  // Point of Reference state hooks
  const [useReferencePoint, setUseReferencePoint] = useLocalStorage('boundaryiq_use_ref_point', false);
  const [refPointName, setRefPointName]           = useLocalStorage('boundaryiq_ref_point_name', 'POR-1');
  const [refPointN, setRefPointN]                 = useLocalStorage('boundaryiq_ref_point_n', '5000.00');
  const [refPointE, setRefPointE]                 = useLocalStorage('boundaryiq_ref_point_e', '5000.00');
  const [pobOffsetMode, setPobOffsetMode]         = useLocalStorage('boundaryiq_pob_offset_mode', true);
  const [pobOffsetN, setPobOffsetN]               = useLocalStorage('boundaryiq_pob_offset_n', '0.00');
  const [pobOffsetE, setPobOffsetE]               = useLocalStorage('boundaryiq_pob_offset_e', '0.00');
  const [refOpen, setRefOpen]                     = useState(false);

  const [distinctRefPoints, setDistinctRefPoints] = useState([]);
  const [selectedRefPoint, setSelectedRefPoint]   = useState('');
  const [deedsForRefPoint, setDeedsForRefPoint]   = useState([]);
  const [combineLoading, setCombineLoading]       = useState(false);
  const [combineMsg, setCombineMsg]               = useState('');

  const getPobCoordinates = () => {
    if (useReferencePoint && pobOffsetMode) {
      const n = (parseFloat(refPointN) || 5000.0) + (parseFloat(pobOffsetN) || 0.0);
      const e = (parseFloat(refPointE) || 5000.0) + (parseFloat(pobOffsetE) || 0.0);
      return { n: n.toFixed(2), e: e.toFixed(2) };
    }
    return { n: pobN, e: pobE };
  };

  const fetchRefPoints = async () => {
    try {
      const res = await fetch(`${API}/diagnostics/reference-points`);
      if (res.ok) {
        const data = await res.json();
        setDistinctRefPoints(data || []);
      }
    } catch (e) {
      console.error('Failed to fetch distinct reference points:', e);
    }
  };

  const fetchDeedsForRefPoint = async (name) => {
    try {
      const res = await fetch(`${API}/diagnostics/by-reference-point?name=${encodeURIComponent(name)}`);
      if (res.ok) {
        const data = await res.json();
        setDeedsForRefPoint(data || []);
      }
    } catch (e) {
      console.error('Failed to fetch deeds for reference point:', e);
    }
  };

  const handleCombineDxf = async () => {
    if (deedsForRefPoint.length === 0) return;
    setCombineLoading(true);
    setCombineMsg('');
    try {
      const parcels = deedsForRefPoint.map(deed => {
        let extraction = deed.extractionJson;
        if (typeof extraction === 'string') {
          try { extraction = JSON.parse(extraction); } catch { extraction = {}; }
        }
        let traverse = deed.traverseJson;
        if (typeof traverse === 'string') {
          try { traverse = JSON.parse(traverse); } catch { traverse = {}; }
        }

        const stations = (traverse.Stations || traverse.stations || []).map(s => ({
          northing: s.Northing ?? s.northing,
          easting: s.Easting ?? s.easting,
          depDN: s.DepDN ?? s.depDN ?? 0,
          depDE: s.DepDE ?? s.depDE ?? 0
        }));

        const adjusted = (traverse.AdjustedStations || traverse.adjustedStations || []).map(s => ({
          northing: s.Northing ?? s.northing,
          easting: s.Easting ?? s.easting
        }));

        const courses = (extraction.Courses || extraction.courses || []).map(c => ({
          type: c.Type ?? c.type ?? 'Line',
          bearing: c.Bearing ?? c.bearing ?? null,
          distance: c.Distance ?? c.distance ?? null,
          delta: c.Delta ?? c.delta ?? null,
          radius: c.Radius ?? c.radius ?? null,
          arcLength: c.ArcLength ?? c.arcLength ?? null,
          curveDirection: c.CurveDirection ?? c.curveDirection ?? null,
          chordBearing: c.ChordBearing ?? c.chordBearing ?? null,
          chordDistance: c.ChordDistance ?? c.chordDistance ?? null
        }));

        return {
          fileName: deed.fileName,
          parcelName: deed.parcelName || deed.fileName,
          stations,
          adjusted,
          courses,
          county: deed.county,
          state: deed.state,
          areaAcres: traverse.AreaAcres ?? traverse.areaAcres ?? 0,
          perimeter: traverse.Perimeter ?? traverse.perimeter ?? 0,
          referencePointName: deed.referencePointName,
          referencePointNorthing: deed.referencePointNorthing,
          referencePointEasting: deed.referencePointEasting,
          pobNorthing: deed.pobNorthing,
          pobEasting: deed.pobEasting
        };
      });

      const res = await fetch(`${API}/dxf/combine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parcels }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Combined DXF export failed');
      }

      const blob = await res.blob();
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: `combined_${selectedRefPoint.replace(/[^a-zA-Z0-9_-]/g, '_')}.dxf`,
      });
      a.click();
      setCombineMsg('✓ Successfully generated and downloaded combined spatially-aligned DXF!');
    } catch (e) {
      setCombineMsg(`✗ Error: ${e.message}`);
    } finally {
      setCombineLoading(false);
    }
  };

  useEffect(() => {
    if (selectedRefPoint) {
      fetchDeedsForRefPoint(selectedRefPoint);
    } else {
      setDeedsForRefPoint([]);
    }
  }, [selectedRefPoint]);
  const [loading, setLoading]   = useState(false);
  const [results, setResults]   = useState(null);   // BatchDeedResult | null
  const [error, setError]       = useState('');
  const [, setExpanded] = useState({});
  const [activeIdx, setActiveIdx] = useState(0);
  const [showPrint, setShowPrint] = useState(false);
  
  const [isEditing, setIsEditing] = useState(false);
  const [editCourses, setEditCourses] = useState([]);
  const [editIsOpenEnded, setEditIsOpenEnded] = useState(false);
  const [correctionStatus, setCorrectionStatus] = useState('');
  const [aiRepairLoading, setAiRepairLoading] = useState(false);

  const [dbQuery, setDbQuery]       = useState('');
  const [dbStatus, setDbStatus]     = useState('');
  const [dbMaxError, setDbMaxError] = useState('');
  const [dbLogs, setDbLogs]         = useState([]);
  const [dbLoading, setDbLoading]   = useState(false);
  const [heuristics, setHeuristics] = useState([]);
  const [recentBatches, setRecentBatches] = useState([]);
  const [expandedBatch, setExpandedBatch] = useState(null); // batchId string
  const [failedCount, setFailedCount]     = useState(null);

  const lastFileRef = useRef('');

  useEffect(() => {
    if (results?.results?.[activeIdx]) {
      const active = results.results[activeIdx];
      setEditCourses(active.extraction?.courses || []);
      setEditIsOpenEnded(active.extraction?.isOpenEnded || false);
      
      if (lastFileRef.current !== active.fileName) {
        setIsEditing(false);
        setCorrectionStatus('');
        lastFileRef.current = active.fileName;
      }
    } else {
      lastFileRef.current = '';
    }
  }, [activeIdx, results]);

  // Folder Scan state
  const [folderPath, setFolderPath] = useLocalStorage('boundaryiq_folder_path', '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/TrainPDF/Regency-Title');
  const [browserOpen, setBrowserOpen] = useState(false);
  const [folderManifest, setFolderManifest] = useState(null);
  const [folderScanLoading, setFolderScanLoading] = useState(false);
  const [folderBatchLoading, setFolderBatchLoading] = useState(false);
  const [folderBatchProgress, setFolderBatchProgress] = useState(null);
  const [batchStatuses, setBatchStatuses] = useState([]);
  const [folderError, setFolderError] = useState('');
  const [lastOutputFolder, setLastOutputFolder] = useState('');
  const [parallelBatches] = useLocalStorage('boundaryiq_parallel_batches', 1);

  // Retry failed state
  const [retryRunning, setRetryRunning] = useState(false);
  const [retryLog, setRetryLog] = useState([]);       // [{type,text}]
  const [retryStats, setRetryStats] = useState(null); // {total,fixed,stillFailing,notFound}
  const [retryAbort, setRetryAbort] = useState(null); // AbortController
  const retryLogRef = useRef(null);
  const [serverLocked, setServerLocked] = useState(false);
  const [lockElapsed, setLockElapsed]   = useState(0);

  const [reprocessLoading, setReprocessLoading] = useState({});

  // Adjacent lot chaining
  const [adjacentDeedText, setAdjacentDeedText] = useState('');
  const [adjacentChainLoading, setAdjacentChainLoading] = useState(false);
  const [adjacentChainStatus, setAdjacentChainStatus] = useState('');

  // Multi-parcel selection
  const [selectedParcelIdx, setSelectedParcelIdx] = useState(0);

  // LOT_BLOCK manual coordinate entry
  const [manualCoords, setManualCoords] = useState([{northing:'',easting:''},{northing:'',easting:''},{northing:'',easting:''}]);
  const [manualPlatLoading, setManualPlatLoading] = useState(false);
  const [manualPlatStatus, setManualPlatStatus]   = useState('');

  // Auto-normalize stale/developer default paths in localStorage to active user path
  useEffect(() => {
    if (folderPath && folderPath.includes('/home/bando')) {
      const normalized = folderPath
        .replace('/home/bando/Downloads/TrainPDF', '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/TrainPDF')
        .replace('/home/bando/Downloads/Legal Descriptions', '/home/artwalk/Downloads/training-20260530T124201Z-3-001/training/Legal Descriptions')
        .replace('/home/bando', '/home/artwalk');
      setFolderPath(normalized);
    }
  }, [folderPath, setFolderPath]);

  const fetchHeuristics = async () => {
    try {
      const res = await fetch(`${API}/diagnostics/heuristics`);
      if (res.ok) {
        const data = await res.json();
        setHeuristics(data);
      }
    } catch (e) { console.error(e); }
  };

  const fetchRecentBatches = async () => {
    try {
      const res = await fetch(`${API}/diagnostics/recent-batches?limit=30`);
      if (res.ok) setRecentBatches(await res.json());
    } catch (e) { console.error(e); }
  };

  const fetchFailedCount = async () => {
    try {
      const res = await fetch(`${API}/diagnostics/failed-deeds?limit=1000`);
      if (res.ok) {
        const data = await res.json();
        setFailedCount(data.length);
      }
    } catch (e) { console.error('Failed to fetch failed deeds count', e); }
  };

  const searchDatabase = async () => {
    setDbLoading(true);
    try {
      const params = new URLSearchParams();
      if (dbQuery) params.append('query', dbQuery);
      if (dbStatus) params.append('status', dbStatus);
      if (dbMaxError) params.append('maxError', dbMaxError);

      const res = await fetch(`${API}/diagnostics/search?${params}`);
      if (res.ok) {
        const data = await res.json();
        setDbLogs(data);
      }
      fetchFailedCount();
      fetchRefPoints();
    } catch (e) { console.error(e); }
    finally { setDbLoading(false); }
  };

  const checkServerLockStatus = async () => {
    try {
      const res = await fetch(`${API}/folderscan/status`);
      if (res.ok) {
        const data = await res.json();
        if (data.busy) {
          setServerLocked(true);
          setLockElapsed(data.elapsedSec);
        } else {
          setServerLocked(false);
        }
      }
    } catch (e) { console.error('Failed to check server lock status:', e); }
  };

  const handleResetLock = async () => {
    try {
      const res = await fetch(`${API}/folderscan/reset-lock`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setServerLocked(false);
        fetchFailedCount();
        setRetryLog(prev => [...prev, { type: 'pass', text: `✓ ${data.message}`, ts: Date.now() }]);
      } else {
        alert('Failed to reset lock.');
      }
    } catch (e) {
      alert('Error resetting lock: ' + e.message);
    }
  };

  // Initial load
  useEffect(() => {
    fetchHeuristics();
    searchDatabase();
    fetchRecentBatches();
    fetchFailedCount();
    checkServerLockStatus();
    fetchRefPoints();
    const interval = setInterval(checkServerLockStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  // Recursively convert PascalCase keys to camelCase (DB stores PascalCase, UI expects camelCase)
  const toCamel = (obj) => {
    if (Array.isArray(obj)) return obj.map(toCamel);
    if (obj !== null && typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj).map(([k, v]) => [
          k.charAt(0).toLowerCase() + k.slice(1),
          toCamel(v),
        ])
      );
    }
    return obj;
  };

  // Load a historical deed log back into the active results view
  const loadFromDb = async (log) => {
    try {
      const rawExtraction = log.extractionJson ? JSON.parse(log.extractionJson) : null;
      const rawTraverse   = log.traverseJson   ? JSON.parse(log.traverseJson)   : null;
      if (!rawExtraction) { alert('No extraction data saved for this entry.'); return; }

      // Convert PascalCase → camelCase so the React views can read them
      const extraction = toCamel(rawExtraction);
      const traverse   = rawTraverse ? toCamel(rawTraverse) : null;

      // Regenerate legal description from the stored courses
      let legalDescription = null;
      const rawCourses = rawExtraction.Courses || rawExtraction.courses || [];
      if (rawCourses.length > 0) {
        try {
          const { n: activePobN, e: activePobE } = getPobCoordinates();
          const writeRes = await fetch(`${API}/writer/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              courses: rawCourses,
              pobNorthing: parseFloat(activePobN),
              pobEasting: parseFloat(activePobE),
              parcelDescription: null,
              county: county || null,
              state: stateVal || null,
              units: 'feet',
              basisOfBearings: null,
              bearingSystem: null,
              areaAcres: traverse?.areaAcres ?? rawTraverse?.AreaAcres ?? 0,
              perimeter: traverse?.perimeter ?? rawTraverse?.Perimeter ?? 0,
            }),
          });
          if (writeRes.ok) {
            const writeData = await writeRes.json();
            legalDescription = writeData;
          }
        } catch (e) {
          console.warn('Failed to regenerate legal description:', e);
        }
      }

      const fakeResult = {
        fileName: log.fileName,
        status: log.status === 'PASS' ? 'success' : 'error',
        extraction,
        traverse,
        legalDescription,
        traverseError: log.status === 'PASS' ? null : `Historical unclosed traverse linear error: ${traverse?.closure?.linearError?.toFixed(4) ?? 'N/A'} ft.`,
      };

      setResults({ results: [fakeResult], total: 1, succeeded: log.status === 'PASS' ? 1 : 0, failed: log.status === 'PASS' ? 0 : 1 });
      setActiveIdx(0);
      setExpanded({ 0: true });

      // Scroll to results
      setTimeout(() => {
        const el = document.getElementById('batch-results-card');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 150);
    } catch (e) {
      alert('Error loading saved data: ' + e.message);
    }
  };

  const handleAiReprocess = async () => {
    const active = results.results[activeIdx];
    if (!active) return;
    setAiRepairLoading(true);
    setCorrectionStatus('🤖 Dispatching AI vision and automated repairs (ignoring cache)...');
    try {
      const { n: activePobN, e: activePobE } = getPobCoordinates();
      const params = new URLSearchParams({
        path: folderPath.trim(),
        file: active.fileName,
        pobN: activePobN,
        pobE: activePobE,
        units: 'Feet',
        force: 'true',
        ...(county ? { county } : {}),
        ...(stateVal ? { state: stateVal } : {}),
        ...(useReferencePoint ? { refName: refPointName, refN: refPointN, refE: refPointE } : {}),
      });

      const res = await fetch(`${API}/folderscan/process-file?${params}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI Reprocessing failed');

      // ── Skipped (cert, plat, non-traversable) ───────────────────────────
      if (data.status === 'skipped') {
        const reason = data.result?.skipReason || data.result?.error || 'File is not a traversable boundary deed (certification, plat, or title document).';
        setCorrectionStatus(`⏭ Skipped — ${reason}`);
        return;
      }

      // ── Success ──────────────────────────────────────────────────────────
      if (data.status === 'success') {
        const repairResult = data.result;
        const newExtraction = toCamel(repairResult.extraction);
        const newTraverse = toCamel(repairResult.traverse);
        const newOriginalEx = toCamel(repairResult.originalExtraction);
        
        setResults(prev => {
          const copy = { ...prev };
          const idx = activeIdx;
          copy.results = copy.results.map((x, i) => i === idx ? {
            ...x,
            status: 'success',
            extraction: newExtraction,
            traverse: newTraverse,
            originalExtraction: newOriginalEx,
            legalDescription: repairResult.legalDescription,
            solutionSteps: repairResult.solutionSteps || null,
            error: null
          } : x);
          return copy;
        });

        setEditCourses(newExtraction?.courses || []);
        setEditIsOpenEnded(newExtraction?.isOpenEnded || false);

        const stage = newExtraction?.repairStageUsed || newTraverse?.repairStageUsed || repairResult.repairStageUsed || 'AI Reprocess Pipeline';
        const steps = repairResult.solutionSteps;
        const stepsMsg = steps?.correctionsApplied > 0 ? ` — ${steps.summary}` : '';
        setCorrectionStatus(`✓ AI successfully repaired and closed this boundary! Stage used: ${stage}${stepsMsg}`);
        setIsEditing(false);
        searchDatabase();
        fetchHeuristics();
        triggerStatsRefresh();   // ← update Dashboard KPIs
        return;
      }

      // ── Failure (FAIL / error) ────────────────────────────────────────────
      const repairResult = data.result || {};
      const newExtraction = toCamel(repairResult.extraction);
      const newTraverse = toCamel(repairResult.traverse);
      const newOriginalEx = toCamel(repairResult.originalExtraction);

      setResults(prev => {
        const copy = { ...prev };
        const idx = activeIdx;
        copy.results = copy.results.map((x, i) => i === idx ? {
          ...x,
          status: 'error',
          extraction: newExtraction,
          traverse: newTraverse,
          originalExtraction: newOriginalEx,
          legalDescription: repairResult.legalDescription,
          error: repairResult.error || 'Failed to close'
        } : x);
        return copy;
      });

      setEditCourses(newExtraction?.courses || []);
      setEditIsOpenEnded(newExtraction?.isOpenEnded || false);

      // Surface the actual traverseError so the user knows WHAT failed
      const failReason = repairResult.error
        || repairResult.traverseError
        || 'Boundary remains unclosed after all repair stages.';
      setCorrectionStatus(`✗ AI Reprocess did not close: ${failReason}`);

    } catch (e) {
      setCorrectionStatus(`✗ AI Reprocess failed: ${e.message}`);
    } finally {
      setAiRepairLoading(false);
    }
  };

  const handleIndividualReprocess = async (fileName) => {
    const folderDir = (folderPath ?? '').trim();
    if (!folderDir) {
      alert('Set a folder path first (Folder Scan panel above) so the system knows where to look for the file.');
      return;
    }
    
    setReprocessLoading(prev => ({ ...prev, [fileName]: true }));
    try {
      const { n: activePobN, e: activePobE } = getPobCoordinates();
      const params = new URLSearchParams({
        path: folderDir,
        file: fileName,
        pobN: activePobN,
        pobE: activePobE,
        units: 'Feet',
        force: 'true',
        ...(county ? { county } : {}),
        ...(stateVal ? { state: stateVal } : {}),
        ...(useReferencePoint ? { refName: refPointName, refN: refPointN, refE: refPointE } : {}),
      });

      const res = await fetch(`${API}/folderscan/process-file?${params}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reprocessing failed');

      if (data.status === 'success') {
        alert(`✓ Reprocessed ${fileName} successfully! The boundary has closed.`);
        searchDatabase();
        triggerStatsRefresh();
      } else {
        const errorMsg = data.result?.error || data.result?.traverseError || 'Closure failure or skipping occurred.';
        alert(`⚠ Reprocess complete for ${fileName}: ${errorMsg}`);
        searchDatabase();
      }
    } catch (e) {
      alert(`Error reprocessing ${fileName}: ${e.message}`);
    } finally {
      setReprocessLoading(prev => ({ ...prev, [fileName]: false }));
    }
  };

  const handleRecomputeCorrection = async () => {
    setCorrectionStatus('🔄 Recomputing traverse...');
    try {
      const res = await fetch(`${API}/traverse/compute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pointOfBeginning: { northing: parseFloat(pobN), easting: parseFloat(pobE) },
          units: 'Feet',
          isOpenEnded: editIsOpenEnded,
          courses: editCourses.map(c => ({
            type: c.type,
            bearing: c.bearing || null,
            distance: c.distance ? parseFloat(c.distance) : null,
            curveDirection: c.curveDirection || 'Right',
            radius: c.radius ? parseFloat(c.radius) : null,
            arcLength: c.arcLength ? parseFloat(c.arcLength) : null,
            chordBearing: c.chordBearing || null,
            chordDistance: c.chordDistance ? parseFloat(c.chordDistance) : null,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Traverse error');
      
      const camelData = toCamel(data);
      
      let resolvedCourses = editCourses;
      if (camelData.courses && camelData.courses.length === editCourses.length) {
        resolvedCourses = camelData.courses.map((rc, idx) => {
          const original = editCourses[idx];
          return {
            ...original,
            bearing: rc.bearing || original.bearing,
            distance: rc.distance != null ? rc.distance.toString() : original.distance,
            chordBearing: rc.chordBearing || original.chordBearing,
            chordDistance: rc.chordDistance != null ? rc.chordDistance.toString() : original.chordDistance,
            isUnknown: rc.isUnknown ?? original.isUnknown
          };
        });
        setEditCourses(resolvedCourses);
      }
      
      setResults(prev => {
        const copy = { ...prev };
        const active = { ...copy.results[activeIdx] };
        active.extraction = {
          ...active.extraction,
          courses: resolvedCourses,
          isOpenEnded: editIsOpenEnded
        };
        active.traverse = camelData;
        copy.results = copy.results.map((x, idx) => idx === activeIdx ? active : x);
        return copy;
      });
      setCorrectionStatus('✓ Traverse recomputed successfully!');
    } catch (e) {
      setCorrectionStatus(`✗ Error: ${e.message}`);
    }
  };

  const handleSaveCorrection = async () => {
    const active = results.results[activeIdx];
    if (!active) return;
    setCorrectionStatus('💾 Saving correction to SQLite database...');
    try {
      const res = await fetch(`${API}/diagnostics/save-correction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: active.fileName,
          parcelName: active.extraction?.parcelName || 'Manual Corrected',
          status: active.traverse?.closure?.status?.startsWith('✓') ? 'PASS' : 'FAIL',
          repairStageUsed: 'Stage 6: Manual Operator Corrected',
          extractionJson: active.extraction,
          traverseJson: active.traverse
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      
      setCorrectionStatus('✓ Saved successfully to diagnostics database!');
      setIsEditing(false);
      searchDatabase();
      fetchHeuristics();
      triggerStatsRefresh();   // ← update Dashboard KPIs
    } catch (e) {
      setCorrectionStatus(`✗ Save Error: ${e.message}`);
    }
  };

  const addEditCourse = () => setEditCourses(prev => [...prev, { type: 'Line', bearing: '', distance: '', curveDirection: 'Right', delta: '', radius: '', arcLength: '', chordBearing: '', chordDistance: '' }]);
  const removeEditCourse = i => setEditCourses(prev => prev.filter((_, idx) => idx !== i));
  const updateEditCourse = (i, field, val) => setEditCourses(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: val } : r));

  const fileRef = useRef();

  const addFiles = newFiles => {
    const arr = Array.from(newFiles).filter(f => f.type.startsWith('image/') || f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    setFiles(prev => {
      const names = new Set(prev.map(f => f.name));
      return [...prev, ...arr.filter(f => !names.has(f.name))].slice(0, 20);
    });
    setResults(null); setError('');
  };

  const removeFile = name => { setFiles(f => f.filter(x => x.name !== name)); setResults(null); };
  const clearCompleted = () => {
    if (!results) return;
    const completedNames = new Set(results.results.map(r => r.fileName));
    setFiles(f => f.filter(x => !completedNames.has(x.name)));
    setResults(null);
  };

  const runBatch = async () => {
    if (!files.length) return;
    setLoading(true); setError(''); setResults(null); setExpanded({}); setActiveIdx(0);
    try {
      const fd = new FormData();
      files.forEach(f => fd.append('images', f));

      const { n: activePobN, e: activePobE } = getPobCoordinates();
      const params = new URLSearchParams({
        pobN: activePobN, pobE: activePobE, units: 'Feet',
        concurrency: concurrentAgents,
        ...(county   ? { county }        : {}),
        ...(stateVal ? { state: stateVal } : {}),
        ...(useReferencePoint ? { refName: refPointName, refN: refPointN, refE: refPointE } : {}),
      });

      const res  = await fetch(`${API}/batchdeed/process?${params}`, { method: 'POST', body: fd });
      const text = await res.text();

      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error(`Server returned non-JSON: ${text.slice(0, 200)}`); }

      if (!res.ok) throw new Error(data?.error ?? `Server error ${res.status}`);
      setResults(data);
    } catch (e) {
      setError(String(e.message));
    } finally {
      setLoading(false);
    }
  };

  // Note: toggle is used inline via setExpanded

  const downloadAll = () => {
    if (!results?.results?.length) return;
    const text = results.results.map((r, i) => {
      const sep = '='.repeat(72);
      if (r.status === 'error') return `${sep}\nFILE ${i + 1}: ${r.fileName}\nERROR: ${r.error}\n${sep}`;
      const prec = r.traverse?.closure?.precisionRatio ?? '—';
      const area = r.traverse?.areaAcres?.toFixed(4) ?? '—';
      const ld   = r.legalDescription?.legalDescription ?? '(no legal description)';
      return `${sep}\nFILE ${i + 1}: ${r.fileName}\nPrecision: ${prec}  |  Area: ${area} ac\n\n${ld}\n${sep}`;
    }).join('\n\n');
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })),
      download: 'batch-deeds.txt',
    });
    a.click();
  };

  const downloadDxf = async () => {
    const r = results.results[activeIdx];
    if (!r?.traverse) { alert('No traverse data to export.'); return; }
    try {
      const { n: activePobN, e: activePobE } = getPobCoordinates();
      const res = await fetch(`${API}/dxf/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stations:         r.traverse.stations,
          adjustedStations: r.traverse.adjustedStations,
          courses:          r.extraction?.courses || [],
          meta: {
            parcel:         r.traverse.parcelName || r.fileName || 'boundary',
            perimeter:      r.traverse.perimeter,
            areaAcres:      r.traverse.areaAcres,
            precisionRatio: r.traverse.closure?.precisionRatio,
            pobNorthing:    parseFloat(activePobN),
            pobEasting:     parseFloat(activePobE),
            county:         county || null,
            state:          stateVal || null,
            compassRuleApplied: r.traverse.compassRuleApplied || false,
          },
        }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'DXF export failed'); }
      const blob = await res.blob();
      const safeName = (r.fileName || 'boundary').replace(/\.[^.]+$/, '');
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: `${safeName}.dxf`,
      });
      a.click();
    } catch (ex) { alert('DXF export error: ' + ex.message); }
  };

  const downloadJson = () => {
    if (!results?.results?.length) return;
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([JSON.stringify(results.results, null, 2)], { type: 'application/json' })),
      download: 'batch-results.json',
    });
    a.click();
  };

  const scanFolder = async () => {
    const path = (folderPath ?? '').trim();
    if (!path) { setFolderError('Please enter a folder path.'); return; }
    setFolderScanLoading(true); setFolderError(''); setFolderManifest(null);
    try {
      const res = await fetch(`${API}/folderscan/scan?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Error ${res.status}`);
      setFolderManifest(data);
    } catch (e) {
      setFolderError(String(e.message));
    } finally {
      setFolderScanLoading(false);
    }
  };

  const runFolderBatches = async () => {
    if (!folderManifest) return;
    const total = folderManifest.batchesNeeded;
    if (total === 0) { setFolderError('No processable deed PDFs in this folder.'); return; }

    // Initialise per-batch status array
    const initStatuses = Array.from({ length: total }, (_, i) => ({ idx: i, status: 'queued', count: 0, error: null }));
    setBatchStatuses(initStatuses);
    setFolderBatchLoading(true);
    setFolderBatchProgress({ current: 0, total, results: [], startTime: Date.now() });
    setFolderError('');
    setLastOutputFolder('');

    // Read auto-output setting from localStorage
    const autoOutputEnabled = (() => {
      try { return JSON.parse(localStorage.getItem('boundaryiq_auto_output') || 'true'); }
      catch { return true; }
    })();

    const baseParams = (() => {
      const { n: activePobN, e: activePobE } = getPobCoordinates();
      return new URLSearchParams({
        path: folderPath.trim(),
        pobN: activePobN,
        pobE: activePobE,
        units: 'Feet',
        concurrency: concurrentAgents,
        ...(autoOutputEnabled ? { autoOutput: 'true' } : {}),
        ...(county   ? { county }          : {}),
        ...(stateVal ? { state: stateVal } : {}),
        ...(useReferencePoint ? { refName: refPointName, refN: refPointN, refE: refPointE } : {}),
      });
    })();

    // Shared mutable accumulator (safe because JS is single-threaded for state)
    let allResults = [];
    let completedBatches = 0;

    const runBatchIndex = async (i) => {
      setBatchStatuses(prev => prev.map(b => b.idx === i ? { ...b, status: 'running' } : b));
      try {
        const p = new URLSearchParams(baseParams);
        p.set('batchIndex', i);
        const res  = await fetch(`${API}/folderscan/process-batch?${p}`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? `Batch ${i} error ${res.status}`);

        if (data?.outputFolder) {
          setLastOutputFolder(data.outputFolder);
        }

        const batchResults = data.results?.results ?? [];
        allResults = [...allResults, ...batchResults];
        completedBatches++;

        setBatchStatuses(prev => prev.map(b => b.idx === i ? { ...b, status: 'done', count: batchResults.length } : b));
        setFolderBatchProgress(prev => ({
          ...prev,
          current: completedBatches,
          results: allResults,
        }));
      } catch (e) {
        completedBatches++;
        setBatchStatuses(prev => prev.map(b => b.idx === i ? { ...b, status: 'error', error: e.message } : b));
        setFolderBatchProgress(prev => ({ ...prev, current: completedBatches }));
        setFolderError(prev => prev ? `${prev} | Batch ${i + 1}: ${e.message}` : `Batch ${i + 1}: ${e.message}`);
      }
    };

    // Rolling parallel pool — never more than parallelBatches streams at once
    const poolSize = Math.max(1, Math.min(parallelBatches, total));
    const indices  = Array.from({ length: total }, (_, i) => i);
    const queue    = [...indices];

    const worker = async () => {
      while (queue.length > 0) {
        const idx = queue.shift();
        if (idx === undefined) break;
        await runBatchIndex(idx);
      }
    };

    await Promise.all(Array.from({ length: poolSize }, worker));

    // All done
    const succeeded = allResults.filter(r => r.status === 'success').length;
    setResults({ results: allResults, total: allResults.length, succeeded, failed: allResults.length - succeeded });
    setFolderBatchLoading(false);
    searchDatabase(); fetchRecentBatches();
    triggerStatsRefresh();   // ← update Dashboard KPIs
  };

  // ── Retry All Failed using local LLMs only ────────────────────────────────
  const handleRetryFailed = async () => {
    const folderDir = (folderPath ?? '').trim();
    if (!folderDir) { alert('Set a folder path first (Folder Scan panel above).'); return; }

    const ctrl = new AbortController();
    setRetryAbort(ctrl);
    setRetryRunning(true);
    setRetryLog([]);
    setRetryStats(null);

    const log = (type, text) => {
      setRetryLog(prev => [...prev.slice(-199), { type, text, ts: Date.now() }]);
      // auto-scroll
      setTimeout(() => { if (retryLogRef.current) retryLogRef.current.scrollTop = retryLogRef.current.scrollHeight; }, 30);
    };

    try {
      const { n: activePobN, e: activePobE } = getPobCoordinates();
      const params = new URLSearchParams({
        path: folderDir,
        pobN: activePobN,
        pobE: activePobE,
        units: 'Feet',
        concurrency: 2,
        maxPasses: 3,
        ...(county   ? { county }          : {}),
        ...(stateVal ? { state: stateVal } : {}),
        ...(useReferencePoint ? { refName: refPointName, refN: refPointN, refE: refPointE } : {}),
      });

      const res = await fetch(`${API}/folderscan/retry-failed?${params}`, {
        method: 'POST', signal: ctrl.signal,
      });

      if (!res.ok) {
        const e = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (res.status === 503) {
          setServerLocked(true);
          const match = e.error?.match(/(\d+)s elapsed/);
          if (match) setLockElapsed(parseInt(match[1]));
        }
        throw new Error(e.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          const eventLine = part.match(/^event: (\w+)/m)?.[1];
          const dataLine  = part.match(/^data: (.+)/m)?.[1];
          if (!eventLine || !dataLine) continue;
          let data;
          try { data = JSON.parse(dataLine); } catch { continue; }

          switch (eventLine) {
            case 'init':
              log('info', `🚀 Starting retry of ${data.total} failed files using ${data.models?.join(' → ')}`);
              setRetryStats({ total: data.total, fixed: 0, stillFailing: 0, notFound: 0 });
              break;
            case 'status':
              log('info', data.message);
              break;
            case 'file-start':
              log('pending', `⏳ [${data.index}/${data.total}] ${data.fileName}`);
              break;
            case 'model-try':
              log('pending', `  🤖 Trying ${data.model}…`);
              break;
            case 'model-fail':
              log('warn', `  ⚠ ${data.model} failed: ${data.error}`);
              break;
            case 'file-pass':
              log('pass', `  ✓ FIXED by ${data.model} — ${data.area} ac  [${data.stage}]`);
              setRetryStats(s => s ? { ...s, fixed: data.fixed } : s);
              // ── Live result push: show the repaired deed immediately ──────
              if (data.result) {
                const fixedResult = toCamel(data.result);
                setResults(prev => {
                  if (!prev) return prev;
                  const existingIdx = prev.results.findIndex(rx => rx.fileName === (fixedResult.fileName || data.fileName));
                  if (existingIdx >= 0) {
                    // Update existing entry
                    const newResults = prev.results.map((rx, ri) =>
                      ri === existingIdx ? { ...rx, ...fixedResult, status: 'success' } : rx
                    );
                    const succeeded = newResults.filter(rx => rx.status === 'success').length;
                    return { ...prev, results: newResults, succeeded, failed: newResults.length - succeeded };
                  } else {
                    // Append as new entry
                    const newResults = [...prev.results, { ...fixedResult, status: 'success' }];
                    const succeeded = newResults.filter(rx => rx.status === 'success').length;
                    return { ...prev, results: newResults, total: newResults.length, succeeded, failed: newResults.length - succeeded };
                  }
                });
              }
              break;
            case 'file-fail':
              log('fail', `  ✗ Still failing: ${data.error || 'all models exhausted'}`);
              setRetryStats(s => s ? { ...s, stillFailing: data.stillFailing } : s);
              break;
            case 'done':
              log('info', `\n🏁 ${data.message}`);
              log('info', `   Fixed: ${data.fixed} | Still failing: ${data.stillFailing} | Not found: ${data.notFound} | Pass rate: ${data.passRate}`);
              setRetryStats({ total: data.total, fixed: data.fixed, stillFailing: data.stillFailing, notFound: data.notFound });
              searchDatabase();
              triggerStatsRefresh();   // ← update Dashboard KPIs
              break;
            case 'error':
              log('fail', `❌ Server error: ${data.message}`);
              break;
          }
        }
      }
    } catch (ex) {
      if (ex.name !== 'AbortError') log('fail', `❌ Connection error: ${ex.message}`);
      else log('info', '⏹ Retry cancelled by user.');
    } finally {
      setRetryRunning(false);
      setRetryAbort(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {/* ── Point of Reference & Coordinate Alignment ── */}
      <div className="card" style={{
        background: 'rgba(9, 14, 26, 0.4)',
        backdropFilter: 'blur(8px)',
        border: useReferencePoint ? '1px solid rgba(0, 212, 168, 0.35)' : '1px solid var(--border)',
        boxShadow: useReferencePoint ? '0 4px 24px rgba(0, 212, 168, 0.08)' : '0 4px 24px rgba(0, 0, 0, 0.15)',
        transition: 'all 0.3s ease',
      }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem', cursor: 'pointer' }} onClick={() => setRefOpen(!refOpen)}>
          <div className="card-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            📍 Point of Reference & Coordinate Alignment
          </div>
          <span style={{ fontSize: '0.75rem', color: useReferencePoint ? 'var(--success)' : 'var(--text-muted)', fontWeight: 600 }}>
            {useReferencePoint ? 'Active (Aligned)' : 'Inactive (Default POB)'} {refOpen ? ' ▲' : ' ▼'}
          </span>
        </div>

        {refOpen && (
          <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem' }}>
              <label style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', cursor: 'pointer', flexShrink: 0, marginTop: '2px' }}>
                <input
                  type="checkbox"
                  checked={useReferencePoint}
                  onChange={e => setUseReferencePoint(e.target.checked)}
                  style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
                />
                <div style={{
                  width: '44px', height: '24px', borderRadius: '12px',
                  background: useReferencePoint ? 'linear-gradient(135deg, #00d4a8 0%, #00b4d8 100%)' : 'rgba(255,255,255,0.1)',
                  border: `1px solid ${useReferencePoint ? 'rgba(0,212,168,0.5)' : 'rgba(255,255,255,0.15)'}`,
                  position: 'relative', transition: 'all 0.3s ease',
                  boxShadow: useReferencePoint ? '0 0 12px rgba(0, 212, 168, 0.3)' : 'none',
                }}>
                  <div style={{
                    width: '18px', height: '18px', borderRadius: '50%', background: '#fff',
                    position: 'absolute', top: '2px', left: useReferencePoint ? '22px' : '3px',
                    transition: 'left 0.3s ease', boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                  }} />
                </div>
              </label>

              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.875rem', marginBottom: '0.35rem' }}>
                  Enable Point of Reference (POR) Mapping
                </div>
                <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  Aligns the Point of Beginning (POB) relative to a common, shared Point of Reference (e.g. section corners, benchmarks). Multiple deeds referencing the same POR will be aligned in a single spatially-correct Coordinate Space.
                </p>
              </div>
            </div>

            {useReferencePoint && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', animation: 'slideDown 0.2s ease', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '1.25rem' }}>
                <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '0.2rem' }}>
                  <span>📍</span> Reference Point Definition
                </div>

                <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1, minWidth: '180px' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Reference Point Name / ID</label>
                    <input
                      type="text"
                      value={refPointName}
                      onChange={e => setRefPointName(e.target.value)}
                      placeholder="e.g. SEC-CORNER-12"
                      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.75rem', color: 'var(--text-primary)', fontSize: '0.8rem' }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1, minWidth: '130px' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>POR Northing (Y)</label>
                    <input
                      type="number"
                      value={refPointN}
                      onChange={e => setRefPointN(e.target.value)}
                      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.75rem', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '0.8rem' }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1, minWidth: '130px' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>POR Easting (X)</label>
                    <input
                      type="number"
                      value={refPointE}
                      onChange={e => setRefPointE(e.target.value)}
                      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.75rem', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '0.8rem' }}
                    />
                  </div>
                </div>

                <div className="divider" style={{ margin: '0.5rem 0' }} />

                <div style={{ fontWeight: 700, color: '#fff', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '0.2rem' }}>
                  <span>📐</span> POB Coordinate Calculation Mode
                </div>

                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', margin: '0.25rem 0' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.78rem', color: pobOffsetMode ? '#fff' : 'var(--text-muted)' }}>
                    <input type="radio" checked={pobOffsetMode} onChange={() => setPobOffsetMode(true)} style={{ accentColor: 'var(--success)' }} />
                    Delta Offset Mode (POB = POR + Offset)
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.78rem', color: !pobOffsetMode ? '#fff' : 'var(--text-muted)' }}>
                    <input type="radio" checked={!pobOffsetMode} onChange={() => setPobOffsetMode(false)} style={{ accentColor: 'var(--success)' }} />
                    Absolute Mode (POB is fixed coordinate)
                  </label>
                </div>

                {pobOffsetMode ? (
                  <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', animation: 'fadeIn 0.2s' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1, minWidth: '130px' }}>
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>POB Delta Northing (ΔN)</label>
                      <input
                        type="number"
                        value={pobOffsetN}
                        onChange={e => setPobOffsetN(e.target.value)}
                        placeholder="0.00"
                        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.75rem', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '0.8rem' }}
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1, minWidth: '130px' }}>
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>POB Delta Easting (ΔE)</label>
                      <input
                        type="number"
                        value={pobOffsetE}
                        onChange={e => setPobOffsetE(e.target.value)}
                        placeholder="0.00"
                        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.75rem', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '0.8rem' }}
                      />
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5, background: 'rgba(255,255,255,0.02)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px dashed var(--border)' }}>
                    ℹ️ <strong>Using Absolute Coordinates:</strong> POB is locked to Northing <strong style={{ color: 'var(--success)' }}>{pobN}</strong> and Easting <strong style={{ color: 'var(--success)' }}>{pobE}</strong>. However, the database record will still log association to the Reference Point <strong style={{ color: '#fff' }}>"{refPointName}"</strong>.
                  </div>
                )}

                <div style={{ fontSize: '0.75rem', padding: '0.6rem 0.85rem', background: 'rgba(0, 212, 168, 0.05)', border: '1px solid rgba(0, 212, 168, 0.2)', borderRadius: 'var(--radius-sm)', display: 'flex', justifyContent: 'space-between', color: '#fff' }}>
                  <span><strong>Calculated Absolute POB:</strong></span>
                  <span style={{ fontFamily: 'monospace', color: 'var(--success)', fontWeight: 700 }}>
                    N: {getPobCoordinates().n} | E: {getPobCoordinates().e}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Folder Scan ─────────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">📁 Folder Scan — Process Entire Directory</div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Point to a server-side folder · Auto-classifies · Skips non-boundary docs</span>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
          <button
            className="btn btn-ghost"
            onClick={() => setBrowserOpen(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.45rem',
              padding: '0.6rem 0.9rem',
              height: '40px',
              flexShrink: 0
            }}
          >
            📁 Browse
          </button>
          <input
            type="text"
            placeholder="/home/user/Downloads/TrainPDF/Regency-Title"
            value={folderPath}
            onChange={e => { setFolderPath(e.target.value); setFolderManifest(null); }}
            style={{
              flex: 1, minWidth: '320px',
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.9rem',
              color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.82rem'
            }}
            onKeyDown={e => e.key === 'Enter' && scanFolder()}
          />
          <button className="btn btn-ghost" onClick={scanFolder} disabled={folderScanLoading}>
            {folderScanLoading ? '⏳ Scanning…' : '🔍 Scan Folder'}
          </button>
        </div>

        {folderError && <div className="alert alert-error" style={{ marginTop: '0.75rem' }}>⚠ {folderError}</div>}

        {folderManifest && (
          <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {/* Stats row */}
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="status-badge pass">✓ {folderManifest.toProcess} processable</span>
              <span className="status-badge fail">⊘ {folderManifest.toSkip} skipped</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{folderManifest.batchesNeeded} batch{folderManifest.batchesNeeded !== 1 ? 'es' : ''} of 20</span>
              {parallelBatches > 1 && !folderBatchLoading && (
                <span style={{ fontSize: '0.78rem', color: '#c97a00', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  ⚡ Turbo: {parallelBatches} parallel streams × {concurrentAgents} agents
                </span>
              )}
              <button
                className="btn btn-primary btn-sm"
                onClick={runFolderBatches}
                disabled={folderBatchLoading || folderManifest.toProcess === 0}
                style={{ marginLeft: 'auto', background: parallelBatches > 1 ? 'linear-gradient(135deg,#c97a00,#e8a000)' : undefined }}
              >
                {folderBatchLoading
                  ? `⚙ Processing… (${folderBatchProgress?.current ?? 0}/${folderBatchProgress?.total ?? 0})`
                  : parallelBatches > 1
                    ? `⚡ Turbo-Process ${folderManifest.toProcess} Deeds`
                    : `▶ Process All ${folderManifest.toProcess} Deeds`}
              </button>
            </div>

            {/* ── Turbo Progress Panel ─────────────────────────────────── */}
            {(folderBatchLoading || batchStatuses.length > 0) && folderBatchProgress && (() => {
              const elapsed   = (Date.now() - (folderBatchProgress.startTime ?? Date.now())) / 1000;
              const doneCount = folderBatchProgress.results.length;
              const rate      = elapsed > 2 ? (doneCount / elapsed).toFixed(2) : '…';
              const remaining = folderBatchProgress.total - folderBatchProgress.current;
              const etaSec    = elapsed > 2 && doneCount > 0
                ? Math.round((elapsed / doneCount) * (folderManifest.toProcess - doneCount))
                : null;
              const etaStr    = etaSec != null
                ? etaSec > 60 ? `${Math.floor(etaSec / 60)}m ${etaSec % 60}s` : `${etaSec}s`
                : '…';
              const pct       = Math.round((folderBatchProgress.current / folderBatchProgress.total) * 100);
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
                  {/* Stat pills */}
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.78rem' }}>
                    <span style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '99px', padding: '0.15rem 0.65rem', color: 'var(--text-muted)' }}>
                      📄 <strong style={{ color: 'var(--text-primary)' }}>{doneCount}</strong> deeds done
                    </span>
                    <span style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '99px', padding: '0.15rem 0.65rem', color: 'var(--text-muted)' }}>
                      🚀 <strong style={{ color: 'var(--success)' }}>{rate}</strong> deeds/sec
                    </span>
                    <span style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '99px', padding: '0.15rem 0.65rem', color: 'var(--text-muted)' }}>
                      ⏱ ETA <strong style={{ color: '#c97a00' }}>{etaStr}</strong>
                    </span>
                    <span style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '99px', padding: '0.15rem 0.65rem', color: 'var(--text-muted)' }}>
                      📦 {remaining} batch{remaining !== 1 ? 'es' : ''} remaining
                    </span>
                  </div>
                  {/* Main progress bar */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                      <span>Batch {folderBatchProgress.current} of {folderBatchProgress.total}</span>
                      <span style={{ fontWeight: 600, color: pct === 100 ? 'var(--success)' : 'var(--text-primary)' }}>{pct}%</span>
                    </div>
                    <div style={{ height: '8px', background: 'var(--bg-elevated)', borderRadius: '4px', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: '4px',
                        background: parallelBatches > 1
                          ? 'linear-gradient(90deg, #c97a00, #e8a000, var(--success))'
                          : 'linear-gradient(90deg, var(--accent), var(--success))',
                        width: `${pct}%`,
                        transition: 'width 0.4s ease',
                        boxShadow: parallelBatches > 1 ? '0 0 8px rgba(201,122,0,0.5)' : undefined,
                      }} />
                    </div>
                  </div>
                  {/* Per-batch status grid */}
                  {batchStatuses.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', maxHeight: '120px', overflowY: 'auto' }}>
                      {batchStatuses.map(b => {
                        const colors = {
                          queued:  { bg: 'var(--bg-elevated)',        border: 'var(--border)',              color: 'var(--text-muted)' },
                          running: { bg: 'rgba(201,122,0,0.12)',       border: 'rgba(201,122,0,0.45)',        color: '#c97a00'           },
                          done:    { bg: 'rgba(0,212,168,0.1)',        border: 'rgba(0,212,168,0.35)',        color: 'var(--success)'    },
                          error:   { bg: 'rgba(220,50,50,0.1)',        border: 'rgba(220,50,50,0.35)',        color: '#dc3232'           },
                        }[b.status] ?? {};
                        const icon = { queued: '○', running: '⚙', done: '✓', error: '✗' }[b.status] ?? '?';
                        return (
                          <div key={b.idx} title={b.error ?? `Batch ${b.idx + 1}: ${b.status}`} style={{
                            padding: '0.2rem 0.55rem', borderRadius: '6px', fontSize: '0.7rem', fontWeight: 600,
                            fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap',
                            background: colors.bg, border: `1px solid ${colors.border}`, color: colors.color,
                            animation: b.status === 'running' ? 'pulse 1.2s ease-in-out infinite' : undefined,
                          }}>
                            {icon} B{b.idx + 1}{b.count > 0 ? ` · ${b.count}` : ''}
                          </div>
                        );
                      })}

                    </div>
                  )}

                </div>
              );
            })()}

            {lastOutputFolder && (
              <div style={{
                background: 'rgba(0, 212, 168, 0.06)',
                border: '1px solid rgba(0, 212, 168, 0.25)',
                borderRadius: '8px',
                padding: '0.85rem 1.1rem',
                margin: '1.2rem 0 0.5rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                fontSize: '0.82rem',
                color: 'var(--success)',
                animation: 'slideDown 0.3s ease-out'
              }}>
                <span style={{ fontSize: '1.2rem' }}>📂</span>
                <div style={{ flex: 1 }}>
                  <strong style={{ color: '#fff', display: 'block', marginBottom: '0.15rem' }}>Outputs Auto-Saved Successfully!</strong>
                  <span style={{ color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.76rem', wordBreak: 'break-all' }}>
                    {lastOutputFolder}
                  </span>
                </div>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    navigator.clipboard.writeText(lastOutputFolder);
                    alert('Output folder path copied to clipboard!');
                  }}
                  style={{
                    padding: '0.25rem 0.65rem',
                    fontSize: '0.7rem',
                    background: 'rgba(0, 212, 168, 0.12)',
                    border: '1px solid rgba(0, 212, 168, 0.25)',
                    color: '#fff',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: 600
                  }}
                >
                  📋 Copy Path
                </button>
              </div>
            )}

            {/* File manifest table */}
            <div className="data-table-wrap" style={{ maxHeight: '280px', overflowY: 'auto' }}>
              <table className="data-table">
                <thead><tr><th>File</th><th>Type</th><th>Size</th><th>Action</th></tr></thead>
                <tbody>
                  {folderManifest.files.map((f, i) => (
                    <tr key={i} style={{ opacity: f.willProcess ? 1 : 0.45 }}>
                      <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem' }}>{f.fileName}</td>
                      <td>
                        <span style={{
                          padding: '0.1rem 0.45rem', borderRadius: '3px', fontSize: '0.72rem',
                          background: f.willProcess ? 'var(--accent)22' : 'var(--bg-card)',
                          color: f.willProcess ? 'var(--accent)' : 'var(--text-muted)',
                          fontWeight: 600
                        }}>{f.docType}</span>
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{f.sizeMb} MB</td>
                      <td style={{ fontSize: '0.78rem' }}>
                        {f.willProcess
                          ? <span style={{ color: 'var(--success)' }}>✓ Process</span>
                          : <span style={{ color: 'var(--text-muted)' }}>⊘ {f.skipReason}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ── Retry Failed — Local LLMs ──────────────────────────────────────── */}
      <div className="card" style={{ borderColor: retryRunning ? 'var(--accent)' : undefined }}>
        <div className="card-header">
          <div className="card-title">
            🔁 Retry All Failed — Local LLMs Only
            {failedCount !== null && (
              <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginLeft: '0.6rem', fontWeight: 'normal' }}>
                ({failedCount} unresolved failure{failedCount !== 1 ? 's' : ''})
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {retryStats && (
              <>
                <span className="status-badge pass">✓ {retryStats.fixed} fixed</span>
                {retryStats.stillFailing > 0 && <span className="status-badge fail">✗ {retryStats.stillFailing} still failing</span>}
                {retryStats.notFound > 0 && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>⊘ {retryStats.notFound} not in folder</span>}
              </>
            )}
            {retryRunning
              ? <button className="btn btn-danger btn-sm" onClick={() => retryAbort?.abort()}>⏹ Stop</button>
              : <button className="btn btn-primary btn-sm" onClick={handleRetryFailed} disabled={folderBatchLoading}>
                  🔁 Select All Failed &amp; Retry with Local LLMs {failedCount !== null && `(${failedCount})`}
                </button>
            }
          </div>
        </div>

        {serverLocked && (
          <div className="alert" style={{ margin: '1rem', display: 'flex', flexDirection: 'column', gap: '0.6rem', border: '1px solid rgba(255, 170, 0, 0.35)', background: 'rgba(255, 170, 0, 0.06)', color: '#ffb74d' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', width: '100%' }}>
              <span className="spinner" style={{ width: 14, height: 14, borderTopColor: '#ffb74d', flexShrink: 0 }} />
              <span style={{ fontSize: '0.85rem' }}>
                <strong>System Lock Active:</strong> Server is currently processing a batch or retry run ({lockElapsed}s elapsed).
              </span>
              <button
                className="btn btn-sm"
                onClick={handleResetLock}
                style={{ marginLeft: 'auto', background: 'rgba(255, 170, 0, 0.15)', color: '#fff', border: '1px solid rgba(255, 170, 0, 0.35)', padding: '0.25rem 0.85rem', fontSize: '0.72rem', fontWeight: 700, borderRadius: 'var(--radius-sm)' }}
              >
                🔓 Force Reset Lock
              </button>
            </div>
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'rgba(255,255,255,0.65)', lineHeight: 1.4 }}>
              If a previous process disconnected or crashed, the server might remain locked. Force-resetting will clear the lock immediately so you can resume.
            </p>
          </div>
        )}

        {/* Model cascade legend */}
        <div style={{ padding: '0 1rem 0.6rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          <span>Model cascade:</span>
          {['gemma3:4b', 'llama3.2:3b', 'deepseek-r1:8b'].map((m, i) => (
            <span key={m} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              {i > 0 && <span>→</span>}
              <span style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '4px', padding: '1px 7px', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem' }}>{m}</span>
            </span>
          ))}
          <span style={{ marginLeft: 'auto', color: 'var(--success)', fontWeight: 600 }}>● No cloud credits used</span>
        </div>

        {/* Progress bar */}
        {retryStats && retryStats.total > 0 && (
          <div style={{ padding: '0 1rem 0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
              <span>{retryStats.fixed + retryStats.stillFailing} / {retryStats.total} processed</span>
              <span style={{ fontWeight: 600, color: 'var(--accent)' }}>
                {retryStats.total > 0 ? Math.round(((retryStats.fixed + retryStats.stillFailing) / retryStats.total) * 100) : 0}%
              </span>
            </div>
            <div style={{ height: '7px', background: 'var(--bg-elevated)', borderRadius: '4px', overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: '4px',
                background: 'linear-gradient(90deg, var(--accent), var(--success))',
                width: `${retryStats.total > 0 ? Math.round(((retryStats.fixed + retryStats.stillFailing) / retryStats.total) * 100) : 0}%`,
                transition: 'width 0.3s ease',
              }} />
            </div>
          </div>
        )}

        {/* Live log */}
        {retryLog.length > 0 && (
          <div
            ref={retryLogRef}
            style={{
              margin: '0 1rem 1rem',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              padding: '0.75rem',
              maxHeight: '300px',
              overflowY: 'auto',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: '0.75rem',
              lineHeight: 1.7,
            }}
          >
            {retryLog.map((entry, i) => (
              <div key={i} style={{
                color: entry.type === 'pass'    ? 'var(--success)'
                     : entry.type === 'fail'    ? 'var(--danger)'
                     : entry.type === 'warn'    ? '#c97a00'
                     : entry.type === 'pending' ? 'var(--text-muted)'
                     : 'var(--text-primary)',
              }}>
                {entry.text}
              </div>
            ))}
            {retryRunning && (
              <div style={{ color: 'var(--accent)', marginTop: '0.25rem' }}>
                <span className="spinner" style={{ width: 10, height: 10, display: 'inline-block', marginRight: 6 }} />
                Processing…
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Setup ─────────────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">📦 Batch Deed Processing</div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Up to 20 plat images · Extract → Compute → Legal Description</span>
        </div>

        {/* Drop zone */}
        <div
          className={`drop-zone ${drag ? 'drag-over' : ''}`}
          style={{ padding: '2rem' }}
          onClick={() => fileRef.current.click()}
          onDragOver={e => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
        >
          <div className="drop-icon">🗂</div>
          <p>Drop plat files, PDFs, or Word docs here or <strong>click to browse</strong><br />
            <span className="text-muted" style={{ fontSize: '0.75rem' }}>JPG · PNG · WebP · PDF · DOC · DOCX — up to 20 files</span></p>
          <input ref={fileRef} type="file" accept="image/*,application/pdf,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple hidden onChange={e => addFiles(e.target.files)} />
        </div>

        {/* File queue — always visible once files are added */}
        {files.length > 0 && (
          <div style={{ marginTop: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <h3>{files.length} file{files.length !== 1 ? 's' : ''} queued</h3>
              {!loading && (
                <div className="flex-row">
                  {results && <button className="btn btn-ghost btn-sm" onClick={clearCompleted}>Clear Completed</button>}
                  <button className="btn btn-ghost btn-sm" onClick={() => { setFiles([]); setResults(null); }}>Clear All</button>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {files.map((f, i) => {
                const r = results?.results?.[i];
                const done = !!r;
                const success = r?.status === 'success';
                return (
                  <div key={f.name} style={{
                    display: 'flex', alignItems: 'center', gap: '0.75rem',
                    background: 'var(--bg-elevated)', border: `1px solid ${done ? (success ? 'rgba(0,212,168,0.3)' : 'rgba(255,77,109,0.3)') : 'var(--border)'}`,
                    borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.75rem',
                    transition: 'border-color 0.3s',
                  }}>
                    <span style={{ fontSize: '1rem' }}>
                      {loading ? '⚙️' : done ? (success ? '✅' : '✗') : '📄'}
                    </span>
                    <span style={{ flex: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{(f.size / 1024).toFixed(0)} KB</span>
                    {done && r?.traverse && (
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap', color: r.traverse.closure.status.startsWith('✓') ? 'var(--success)' : 'var(--danger)' }}>
                        {r.traverse.closure.precisionRatio}
                      </span>
                    )}
                    {done && r?.status === 'error' && (
                      <span style={{ fontSize: '0.72rem', color: 'var(--danger)' }}>Error</span>
                    )}
                    {!loading && !done && (
                      <button onClick={() => removeFile(f.name)} style={{ background: 'rgba(255,77,109,0.12)', border: '1px solid rgba(255,77,109,0.3)', color: 'var(--danger)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}>✕</button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex-row mt-2" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" onClick={runBatch} disabled={loading || files.length === 0}>
            {loading
              ? <><span className="spinner" style={{ width: 16, height: 16 }} /> Processing {files.length} file{files.length !== 1 ? 's' : ''}…</>
              : `⚡ Run Batch${files.length > 0 ? ` (${files.length})` : ''}`}
          </button>
        </div>
      </div>

      {/* ── Error ─────────────────────────────────────────────────────────────── */}
      {error && <div className="alert alert-error">⚠ {error}</div>}

      {/* ── Results summary + download ─────────────────────────────────────────── */}
      {results && (
        <div id="batch-results-card" className="card" style={{ maxWidth: '100%' }}>
          <div className="card-header" style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
            <div>
              <div className="card-title">📊 Results — {results.totalProcessed} processed</div>
              <span className="text-muted" style={{ fontSize: '0.72rem' }}>Click any file tab below to inspect its detailed split-view</span>
            </div>
            <div className="flex-row">
              <span className="status-badge pass">✓ {results.succeeded} OK</span>
              {results.failed > 0 && <span className="status-badge fail">✗ {results.failed} failed</span>}
              <button className="btn btn-ghost btn-sm" onClick={downloadJson}>⬇ Export JSON</button>
              {results.results[activeIdx]?.traverse && (
                <button className="btn btn-ghost btn-sm" onClick={downloadDxf} style={{ color: '#c97a00', border: '1px solid rgba(201,122,0,0.4)' }}>⬇ DXF</button>
              )}
              <button className="btn btn-success btn-sm" onClick={downloadAll}>⬇ Download All (.txt)</button>
            </div>
          </div>

          {/* Horizontal file selector tabs */}
          <div style={{
            display: 'flex',
            gap: '0.5rem',
            overflowX: 'auto',
            paddingBottom: '0.75rem',
            borderBottom: '1px solid var(--border)',
            marginBottom: '1.25rem'
          }}>
            {results.results.map((r, i) => {
              const success = r.status === 'success';
              const ts = r.trustScore;
              const trustLevel = r.trustLevel || (ts >= 80 ? 'HIGH' : ts >= 55 ? 'MED' : 'LOW');
              const trustColor = trustLevel === 'HIGH' ? '#00d4a8' : trustLevel === 'MED' ? '#c97a00' : '#dc3232';
              return (
                <button
                  key={i}
                  className={`btn ${activeIdx === i ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setActiveIdx(i)}
                  title={r.trustFlags?.length > 0 ? r.trustFlags.join('\n') : undefined}
                  style={{
                    whiteSpace: 'nowrap',
                    padding: '0.4rem 0.8rem',
                    fontSize: '0.8rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    border: activeIdx === i ? '1px solid var(--accent)' : '1px solid transparent',
                    background: activeIdx === i ? 'var(--accent)' : 'var(--bg-elevated)',
                    color: activeIdx === i ? '#fff' : 'var(--text-secondary)',
                    borderRadius: 'var(--radius-sm)'
                  }}
                >
                  <span>{success ? '✅' : '❌'}</span>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{r.fileName}</span>
                  {ts != null && (
                    <span style={{
                      fontSize: '0.62rem', fontWeight: 700, padding: '1px 5px',
                      borderRadius: '3px', flexShrink: 0,
                      background: `${trustColor}22`,
                      border: `1px solid ${trustColor}66`,
                      color: trustColor,
                    }}>
                      {trustLevel === 'MED' ? 'MED' : trustLevel} {ts}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Active Result Split Window */}
          {(() => {
            const r = results.results[activeIdx];
            if (!r) return null;

            return (
              <div className="grid-2" style={{ gap: '1.5rem', alignItems: 'start' }}>
                
                {/* Left Panel: OCR Output */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)',
                    padding: '1.25rem'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                      <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem' }}>
                        <span>🔤</span> OCR & Boundary Extraction
                      </h3>
                      {!isEditing && r.extraction?.courses?.length > 0 && (
                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => {
                              setEditCourses(r.extraction?.courses || []);
                              setEditIsOpenEnded(r.extraction?.isOpenEnded || false);
                              setIsEditing(true);
                              setCorrectionStatus('');
                            }}
                            style={{
                              padding: '0.2rem 0.6rem', fontSize: '0.72rem',
                              border: '1px solid rgba(0, 212, 168, 0.3)',
                              background: 'rgba(0, 212, 168, 0.05)',
                              color: 'var(--success)'
                            }}
                          >
                            ✏️ Manual Correct
                          </button>
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={handleAiReprocess}
                            disabled={aiRepairLoading}
                            style={{
                              padding: '0.2rem 0.6rem', fontSize: '0.72rem',
                              background: 'linear-gradient(135deg, var(--accent), var(--accent2))',
                              border: 'none',
                              color: '#fff',
                              boxShadow: '0 0 10px rgba(0, 212, 168, 0.3)',
                              cursor: aiRepairLoading ? 'not-allowed' : 'pointer'
                            }}
                          >
                            {aiRepairLoading ? '⏳ AI Repairing…' : '🤖 AI Reprocess'}
                          </button>
                        </div>
                      )}
                    </div>
                    
                    {r.status === 'error' && (
                      <div className="alert alert-error">⚠ {r.error}</div>
                    )}

                    {correctionStatus && !isEditing && (
                      <div style={{
                        fontSize: '0.78rem',
                        padding: '0.5rem 0.8rem',
                        background: 'var(--bg-card)',
                        borderLeft: `3px solid ${correctionStatus.startsWith('✓') ? 'var(--success)' : correctionStatus.startsWith('✗') ? 'var(--danger)' : 'var(--accent)'}`,
                        borderRadius: '4px',
                        color: 'var(--text-primary)',
                        marginBottom: '0.75rem'
                      }}>
                        {correctionStatus}
                      </div>
                    )}

                    {isEditing ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        {/* Course List Table */}
                        <div className="data-table-wrap" style={{ maxHeight: '350px', overflowY: 'auto' }}>
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th style={{ width: '40px' }}>#</th>
                                <th style={{ width: '90px' }}>Type</th>
                                <th>Bearing / Chord</th>
                                <th>Dist / Radius / Arc</th>
                                <th style={{ width: '40px' }}></th>
                              </tr>
                            </thead>
                            <tbody>
                              {editCourses.map((c, j) => (
                                <tr key={j}>
                                  <td>{j + 1}</td>
                                  <td>
                                    <select
                                      value={c.type}
                                      onChange={e => updateEditCourse(j, 'type', e.target.value)}
                                      style={{ width: '100%', padding: '0.25rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '0.75rem' }}
                                    >
                                      <option value="Line">Line</option>
                                      <option value="Curve">Curve</option>
                                    </select>
                                  </td>
                                  <td>
                                    {c.type === 'Line' ? (
                                      <input
                                        type="text"
                                        value={c.bearing || ''}
                                        onChange={e => updateEditCourse(j, 'bearing', e.target.value)}
                                        placeholder="e.g. N45-30-00E"
                                        style={{ width: '100%', padding: '0.25rem 0.4rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono', fontSize: '0.75rem' }}
                                      />
                                    ) : (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                        <select
                                          value={c.curveDirection || 'Right'}
                                          onChange={e => updateEditCourse(j, 'curveDirection', e.target.value)}
                                          style={{ width: '100%', padding: '0.2rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '0.7rem' }}
                                        >
                                          <option value="Right">Right (CW)</option>
                                          <option value="Left">Left (CCW)</option>
                                        </select>
                                        <input
                                          type="text"
                                          value={c.chordBearing || ''}
                                          onChange={e => updateEditCourse(j, 'chordBearing', e.target.value)}
                                          placeholder="Chord Brg"
                                          style={{ width: '100%', padding: '0.2rem 0.4rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono', fontSize: '0.7rem' }}
                                        />
                                      </div>
                                    )}
                                  </td>
                                  <td>
                                    {c.type === 'Line' ? (
                                      <input
                                        type="text"
                                        value={c.distance || ''}
                                        onChange={e => updateEditCourse(j, 'distance', e.target.value)}
                                        placeholder="Dist (ft)"
                                        style={{ width: '100%', padding: '0.25rem 0.4rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono', fontSize: '0.75rem' }}
                                      />
                                    ) : (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                        <input
                                          type="text"
                                          value={c.radius || ''}
                                          onChange={e => updateEditCourse(j, 'radius', e.target.value)}
                                          placeholder="Radius"
                                          style={{ width: '100%', padding: '0.2rem 0.4rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono', fontSize: '0.7rem' }}
                                        />
                                        <input
                                          type="text"
                                          value={c.arcLength || ''}
                                          onChange={e => updateEditCourse(j, 'arcLength', e.target.value)}
                                          placeholder="Arc Length"
                                          style={{ width: '100%', padding: '0.2rem 0.4rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono', fontSize: '0.7rem' }}
                                        />
                                        <input
                                          type="text"
                                          value={c.chordDistance || ''}
                                          onChange={e => updateEditCourse(j, 'chordDistance', e.target.value)}
                                          placeholder="Chord Dist"
                                          style={{ width: '100%', padding: '0.2rem 0.4rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono', fontSize: '0.7rem' }}
                                        />
                                      </div>
                                    )}
                                  </td>
                                  <td>
                                    <button
                                      className="btn btn-ghost btn-sm"
                                      onClick={() => removeEditCourse(j)}
                                      style={{ padding: '0.2rem', color: 'var(--danger)', display: 'flex', alignItems: 'center' }}
                                      title="Delete segment"
                                    >
                                      🗑️
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {/* Add course and open-ended flag */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginTop: '0.25rem' }}>
                          <button 
                            className="btn btn-sm btn-ghost" 
                            onClick={addEditCourse}
                            style={{ border: '1px dashed var(--border)', color: 'var(--text-secondary)' }}
                          >
                            ➕ Add Course
                          </button>
                          
                          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                            <input 
                              type="checkbox" 
                              checked={editIsOpenEnded} 
                              onChange={e => setEditIsOpenEnded(e.target.checked)} 
                            />
                            IsOpenEnded (Linear Easement)
                          </label>
                        </div>

                        {correctionStatus && (
                          <div style={{
                            fontSize: '0.78rem',
                            padding: '0.5rem 0.8rem',
                            background: 'var(--bg-card)',
                            borderLeft: `3px solid ${correctionStatus.startsWith('✓') ? 'var(--success)' : correctionStatus.startsWith('✗') ? 'var(--danger)' : 'var(--accent)'}`,
                            borderRadius: '4px',
                            color: 'var(--text-primary)'
                          }}>
                            {correctionStatus}
                          </div>
                        )}

                        {/* Action buttons */}
                        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                          <button 
                            className="btn btn-sm btn-primary" 
                            onClick={handleRecomputeCorrection}
                            style={{ flex: 1 }}
                          >
                            🔄 Recompute & Test
                          </button>
                          <button 
                            className="btn btn-sm btn-ghost" 
                            onClick={handleSaveCorrection}
                            style={{ flex: 1, border: '1px solid var(--accent2)', color: 'var(--accent2)', background: 'rgba(0, 212, 168, 0.05)' }}
                          >
                            💾 Save Correction
                          </button>
                          <button 
                            className="btn btn-sm btn-ghost" 
                            onClick={() => {
                              setIsEditing(false);
                              setEditCourses(r.extraction?.courses || []);
                              setEditIsOpenEnded(r.extraction?.isOpenEnded || false);
                              setCorrectionStatus('');
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : r.extraction?.courses?.length > 0 ? (
                      <div className="data-table-wrap" style={{ maxHeight: '320px', overflowY: 'auto' }}>
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Type</th>
                              <th>Bearing / Chord</th>
                              <th>Dist / Arc</th>
                            </tr>
                          </thead>
                          <tbody>
                          {r.extraction.courses.map((c, j) => (
                            <tr key={j}>
                              <td>{j + 1}</td>
                              <td style={{ color: c.type === 'Curve' ? 'var(--warning)' : 'var(--accent)', fontWeight: 500 }}>
                                {c.type}
                              </td>
                              <td>{c.bearing || c.chordBearing || '—'}</td>
                              <td>{c.distance ?? c.arcLength ?? c.chordDistance ?? '—'}</td>
                            </tr>
                          ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      r.status === 'success' && <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No boundary courses extracted.</div>
                    )}
                  </div>

                  {/* ── Multi-Parcel Tabs ───────────────────────────────────────── */}
                  {r.extraction?.parcels?.length > 1 && (
                    <div style={{ background: 'rgba(100,130,255,0.07)', border: '1px solid rgba(100,130,255,0.3)', borderRadius: 'var(--radius-sm)', padding: '0.75rem 1rem', marginBottom: '0.5rem' }}>
                      <div style={{ fontSize: '0.72rem', color: '#8090ff', fontWeight: 600, marginBottom: '0.5rem' }}>
                        📍 Multi-Parcel Document — {r.extraction.parcels.length} parcels detected
                      </div>
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                        {r.extraction.parcels.map((p, pi) => (
                          <button
                            key={pi}
                            className={`btn btn-sm ${selectedParcelIdx === pi ? 'btn-primary' : 'btn-ghost'}`}
                            onClick={() => setSelectedParcelIdx(pi)}
                            style={{ fontSize: '0.72rem', padding: '0.2rem 0.65rem' }}
                          >
                            Parcel {p.parcelId || p.ParcelId || (pi + 1)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── Adjacent Lot Review Chaining ─────────────────────────── */}
                  {r.status === 'error' && r.repairStageUsed?.includes('Adjacent Lot') && (
                    <div style={{ background: 'rgba(201,122,0,0.07)', border: '1px solid rgba(201,122,0,0.35)', borderRadius: 'var(--radius-sm)', padding: '0.85rem 1rem' }}>
                      <div style={{ fontSize: '0.78rem', color: '#c97a00', fontWeight: 600, marginBottom: '0.4rem' }}>
                        ⚠️ Adjacent Lot Reference Detected
                        {r.extraction?.referencedParcelName && (
                          <span style={{ fontWeight: 400, color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>
                            — References: <strong style={{ color: '#c97a00' }}>{r.extraction.referencedParcelName}</strong>
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.73rem', color: 'var(--text-muted)', marginBottom: '0.6rem' }}>
                        This deed references an adjacent parcel boundary. Paste the referenced deed description below to complete the traverse.
                      </div>
                      <textarea
                        value={adjacentDeedText}
                        onChange={e => setAdjacentDeedText(e.target.value)}
                        placeholder={`Paste the legal description for "${r.extraction?.referencedParcelName || 'the referenced parcel'}" here…`}
                        rows={5}
                        style={{
                          width: '100%', resize: 'vertical', padding: '0.6rem 0.75rem', marginBottom: '0.6rem',
                          background: 'var(--bg-card)', border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)',
                          fontFamily: 'JetBrains Mono, monospace', fontSize: '0.74rem', lineHeight: 1.6,
                        }}
                      />
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={!adjacentDeedText.trim() || adjacentChainLoading}
                          onClick={async () => {
                            setAdjacentChainLoading(true);
                            setAdjacentChainStatus('🤖 Extracting secondary deed courses and splicing…');
                            try {
                              const res = await fetch(`${API}/folderscan/chain-adjacent`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  primaryCourses: r.extraction?.courses || [],
                                  secondaryDeedText: adjacentDeedText.trim(),
                                  pob: { northing: parseFloat(pobN) || 5000, easting: parseFloat(pobE) || 5000 },
                                  units: 'Feet',
                                  county: county || null,
                                  state: stateVal || null,
                                  fileName: r.fileName,
                                }),
                              });
                              const data = await res.json();
                              if (!res.ok) throw new Error(data.error || 'Failed');
                              if (data.status === 'success') {
                                const strategy = data.result?.strategy || 'gap-solver';
                                const spliced  = data.result?.spliced ? ' [segment spliced]' : '';
                                setAdjacentChainStatus(`✓ Traverse closed! Strategy: ${strategy}${spliced}`);
                                setResults(prev => ({
                                  ...prev,
                                  results: prev.results.map((rx, ri) => ri === activeIdx ? { ...rx, ...data.result, status: 'success' } : rx)
                                }));
                              } else {
                                setAdjacentChainStatus(`✗ Still failed: ${data.result?.error || 'Unknown error'}`);
                              }
                            } catch (ex) {
                              setAdjacentChainStatus(`✗ Error: ${ex.message}`);
                            } finally {
                              setAdjacentChainLoading(false);
                            }
                          }}
                        >
                          {adjacentChainLoading ? '⏳ Processing…' : '🔗 Chain & Recompute Traverse'}
                        </button>
                        {adjacentChainStatus && (
                          <span style={{ fontSize: '0.75rem', color: adjacentChainStatus.startsWith('✓') ? 'var(--success)' : 'var(--danger)' }}>
                            {adjacentChainStatus}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ── LOT_BLOCK Manual Coordinate Entry ─────────────────── */}
                  {r.status === 'error' && r.extraction?.classification === 'LOT_BLOCK' && (
                    <div style={{ background: 'rgba(100,130,255,0.07)', border: '1px solid rgba(100,130,255,0.35)', borderRadius: 'var(--radius-sm)', padding: '0.85rem 1rem' }}>
                      <div style={{ fontSize: '0.78rem', color: '#8090ff', fontWeight: 600, marginBottom: '0.4rem' }}>
                        📌 LOT_BLOCK — Enter Plat Coordinates Manually
                      </div>
                      <div style={{ fontSize: '0.73rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                        No metes-and-bounds geometry found. Enter the corner coordinates from the recorded plat (minimum 3 corners).
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginBottom: '0.75rem' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '24px 1fr 1fr 28px', gap: '0.4rem', fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                          <span>#</span><span>Northing (ft)</span><span>Easting (ft)</span><span></span>
                        </div>
                        {manualCoords.map((pt, mi) => (
                          <div key={mi} style={{ display: 'grid', gridTemplateColumns: '24px 1fr 1fr 28px', gap: '0.4rem', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>{mi + 1}</span>
                            <input
                              type="text"
                              value={pt.northing}
                              onChange={e => setManualCoords(prev => prev.map((p, i) => i === mi ? { ...p, northing: e.target.value } : p))}
                              placeholder="e.g. 5234.50"
                              style={{ padding: '0.3rem 0.5rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem' }}
                            />
                            <input
                              type="text"
                              value={pt.easting}
                              onChange={e => setManualCoords(prev => prev.map((p, i) => i === mi ? { ...p, easting: e.target.value } : p))}
                              placeholder="e.g. 5148.75"
                              style={{ padding: '0.3rem 0.5rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem' }}
                            />
                            {manualCoords.length > 3 && (
                              <button onClick={() => setManualCoords(prev => prev.filter((_, i) => i !== mi))} style={{ background: 'rgba(220,50,50,0.1)', border: '1px solid rgba(220,50,50,0.3)', color: 'var(--danger)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: '0.75rem', padding: '0.2rem 0.4rem' }}>✕</button>
                            )}
                          </div>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setManualCoords(prev => [...prev, { northing: '', easting: '' }])}
                          style={{ border: '1px dashed var(--border)', color: 'var(--text-secondary)', fontSize: '0.72rem' }}
                        >
                          ➕ Add Corner
                        </button>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={manualPlatLoading || manualCoords.filter(p => p.northing && p.easting).length < 3}
                          onClick={async () => {
                            const valid = manualCoords.filter(p => p.northing.trim() && p.easting.trim());
                            if (valid.length < 3) { setManualPlatStatus('✗ Enter at least 3 corner coordinates.'); return; }
                            setManualPlatLoading(true);
                            setManualPlatStatus('⏳ Computing traverse from coordinates…');
                            try {
                              const { n: activePobN, e: activePobE } = getPobCoordinates();
                              const res = await fetch(`${API}/folderscan/resolve-plat-manual`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  fileName: r.fileName,
                                  vertices: valid.map(p => ({ northing: parseFloat(p.northing), easting: parseFloat(p.easting) })),
                                  pobNorthing: parseFloat(activePobN) || 5000,
                                  pobEasting: parseFloat(activePobE) || 5000,
                                  county: county || null,
                                  state: stateVal || null,
                                }),
                              });
                              const data = await res.json();
                              if (!res.ok) throw new Error(data.error || 'Failed');
                              if (data.status === 'success') {
                                setManualPlatStatus(`✓ Traverse closed! Area: ${data.result?.traverse?.areaAcres?.toFixed(4) || '?'} ac`);
                                setResults(prev => ({
                                  ...prev,
                                  results: prev.results.map((rx, ri) => ri === activeIdx ? { ...rx, ...toCamel(data.result), status: 'success' } : rx)
                                }));
                                triggerStatsRefresh();
                              } else {
                                setManualPlatStatus(`✗ ${data.result?.error || 'Still failed'}`);
                              }
                            } catch (ex) {
                              setManualPlatStatus(`✗ Error: ${ex.message}`);
                            } finally {
                              setManualPlatLoading(false);
                            }
                          }}
                        >
                          {manualPlatLoading ? '⏳ Computing…' : '📐 Compute Traverse'}
                        </button>
                        {manualPlatStatus && (
                          <span style={{ fontSize: '0.75rem', color: manualPlatStatus.startsWith('✓') ? 'var(--success)' : manualPlatStatus.startsWith('✗') ? 'var(--danger)' : 'var(--accent)' }}>
                            {manualPlatStatus}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {r.legalDescription?.legalDescription && (
                    <div style={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                      padding: '1.25rem'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, fontSize: '0.95rem' }}>
                          <span>✍️</span> Generated Legal Description
                        </h3>
                        <button className="btn btn-ghost btn-sm"
                          onClick={() => navigator.clipboard.writeText(r.legalDescription.legalDescription)}>
                          📋 Copy
                        </button>
                      </div>
                      <pre style={{
                        background: 'var(--bg-card)', border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-sm)', padding: '1rem',
                        fontFamily: 'Georgia, serif', fontSize: '0.85rem', lineHeight: 1.9,
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 250, overflowY: 'auto',
                      }}>
                        {r.legalDescription.legalDescription}
                      </pre>
                    </div>
                  )}
                </div>

                {/* Right Panel: Parcel Map & Closure */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  {r.extraction?.courses?.length > 0 && (
                    <div style={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                      padding: '1.25rem'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem' }}>
                          <span>🗺️</span> Parcel Map
                        </h3>
                        <button className="btn btn-primary btn-sm" onClick={() => { setActiveIdx(activeIdx); setShowPrint(true); }}>
                          📐 Open Survey Map & Print
                        </button>
                      </div>
                      <div style={{ borderRadius: 'var(--radius-sm)', overflow: 'hidden', border: '1px solid var(--border)' }}>
                        <TraverseMap
                          key={`${activeIdx}_${r.fileName}_${r.traverse?.stations?.length || 0}_${r.traverse?.closure?.linearError || 0}`}
                          stations={r.traverse?.stations}
                          adjusted={r.traverse?.adjustedStations}
                          courses={r.extraction?.courses || []}
                        />
                      </div>
                    </div>
                  )}

                  {r.traverse && (
                    <div style={{
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                      padding: '1.25rem'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem' }}>
                          <span>📊</span> Closure Report
                          {r.traverse.compassRuleApplied && (
                            <span style={{ fontSize: '0.65rem', background: 'rgba(0,212,168,0.12)', border: '1px solid rgba(0,212,168,0.35)', borderRadius: '4px', padding: '1px 7px', color: 'var(--success)', fontWeight: 600, marginLeft: '0.4rem' }}>
                              ✓ Compass Rule Applied
                            </span>
                          )}
                        </h3>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={downloadDxf}
                          style={{ fontSize: '0.72rem', color: '#c97a00', border: '1px solid rgba(201,122,0,0.4)', padding: '0.2rem 0.65rem' }}
                        >
                          ⬇ Export DXF
                        </button>
                      </div>
                      <div className="closure-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                        {[
                          ['Precision', r.traverse.closure?.precisionRatio, r.traverse.closure?.status?.startsWith('✓') ? 'pass' : 'fail'],
                          ['Linear Error',
                            r.traverse.compassRuleApplied
                              ? `${(r.traverse.compassRuleOriginalError ?? 0).toFixed(4)}' → 0.0000' (adj)`
                              : `${(r.traverse.closure?.linearError ?? 0).toFixed(4)}'`,
                            'neutral'
                          ],
                          ['Perimeter',    `${(r.traverse.perimeter ?? 0).toFixed(2)}'`,           'neutral'],
                          ['Area',         `${(r.traverse.areaAcres ?? 0).toFixed(4)} ac`,          'neutral'],
                        ].map(([label, value, cls]) => (
                          <div className="closure-stat" key={label} style={{ padding: '0.5rem 0.75rem', background: 'var(--bg-card)' }}>
                            <div className="label" style={{ fontSize: '0.7rem' }}>{label}</div>
                            <div className={`value ${cls}`} style={{ fontSize: '1rem' }}>{value}</div>
                          </div>
                        ))}
                      </div>
                      {r.traverse.compassRuleApplied && (
                        <div style={{ marginTop: '0.75rem', fontSize: '0.72rem', color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
                          Bowditch (Compass Rule) adjustment applied — original closure {r.traverse.compassRuleOriginalPrecision}, error {(r.traverse.compassRuleOriginalError ?? 0).toFixed(4)} ft distributed proportionally across all courses.
                        </div>
                      )}

                      {/* ── Trust Score Badge (Priority 4) ─────────────────── */}
                      {r.trustScore != null && (() => {
                        const ts = r.trustScore;
                        const level = r.trustLevel || (ts >= 80 ? 'HIGH' : ts >= 55 ? 'MEDIUM' : 'LOW');
                        const [color, bg] = level === 'HIGH'
                          ? ['var(--success)', 'rgba(0,212,168,0.1)']
                          : level === 'MEDIUM'
                          ? ['#c97a00', 'rgba(201,122,0,0.1)']
                          : ['var(--danger)', 'rgba(220,50,50,0.1)'];
                        const flags = r.trustFlags || [];
                        return (
                          <div style={{ marginTop: '0.75rem', borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>AI Confidence</span>
                              <span style={{
                                padding: '0.15rem 0.65rem', borderRadius: '99px',
                                background: bg, border: `1px solid ${color}55`,
                                color, fontWeight: 700, fontSize: '0.72rem',
                              }}>
                                {level} · {ts}/100
                              </span>
                              {flags.length > 0 && (
                                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', cursor: 'default' }} title={flags.join('\n')}>
                                  ⚠ {flags.length} flag{flags.length !== 1 ? 's' : ''}
                                </span>
                              )}
                            </div>
                            {flags.length > 0 && (
                              <div style={{ marginTop: '0.4rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                                {flags.map((f, fi) => (
                                  <div key={fi} style={{ fontSize: '0.68rem', color: '#c97a00', fontFamily: 'JetBrains Mono, monospace', paddingLeft: '0.4rem', borderLeft: '2px solid rgba(201,122,0,0.4)' }}>
                                    {f}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>

              </div>
            );
          })()}
        </div>
      )}
      {/* ── Batch Run History ─────────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: '1.5rem' }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem', marginBottom: '1rem' }}>
          <div className="card-title">📊 Batch Run History</div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Last {recentBatches.length} runs · click a row to expand</span>
            <button className="btn btn-ghost btn-sm" onClick={fetchRecentBatches}>↻ Refresh</button>
          </div>
        </div>

        {recentBatches.length === 0 ? (
          <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>No batch runs yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {recentBatches.map((batch, bi) => {
              const s = batch.stats;
              const c = s?.counts || {};
              const pct = c.total > 0 ? Math.round((c.passed / c.total) * 100) : Math.round((batch.passRate || 0) * 100);
              const isExpanded = expandedBatch === batch.batchId;
              const barColor = pct >= 90 ? 'var(--success)' : pct >= 70 ? '#c97a00' : 'var(--danger)';
              const ts = batch.timestamp?.replace('T',' ').slice(0,16) || '';

              return (
                <div key={batch.batchId} style={{ borderBottom: bi < recentBatches.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  {/* Summary row */}
                  <div
                    onClick={() => setExpandedBatch(isExpanded ? null : batch.batchId)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.75rem',
                      padding: '0.65rem 1rem', cursor: 'pointer',
                      background: isExpanded ? 'var(--bg-elevated)' : 'transparent',
                      transition: 'background 0.15s',
                    }}
                  >
                    {/* Expand arrow */}
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem', width: 12 }}>{isExpanded ? '▾' : '▸'}</span>

                    {/* Timestamp */}
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem', color: 'var(--text-muted)', minWidth: 130 }}>{ts}</span>

                    {/* Pass rate bar */}
                    <div style={{ flex: 1, maxWidth: 160, minWidth: 80 }}>
                      <div style={{ height: 6, background: 'var(--bg-elevated)', borderRadius: 3, overflow: 'hidden', border: '1px solid var(--border)' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: 3, transition: 'width 0.3s' }} />
                      </div>
                    </div>

                    {/* Pass % */}
                    <span style={{ fontSize: '0.78rem', fontWeight: 700, color: barColor, minWidth: 38 }}>{pct}%</span>

                    {/* Stat pills */}
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', flex: 1 }}>
                      {c.total > 0 && <span style={{ fontSize: '0.7rem', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 7px' }}>{c.total} files</span>}
                      {c.passed  > 0 && <span style={{ fontSize: '0.7rem', background: 'rgba(0,212,168,0.12)', border: '1px solid rgba(0,212,168,0.3)', borderRadius: 4, padding: '1px 7px', color: 'var(--success)', fontWeight: 600 }}>✓ {c.passed}</span>}
                      {c.failed  > 0 && <span style={{ fontSize: '0.7rem', background: 'rgba(220,50,50,0.1)',  border: '1px solid rgba(220,50,50,0.3)',  borderRadius: 4, padding: '1px 7px', color: 'var(--danger)',  fontWeight: 600 }}>✗ {c.failed}</span>}
                      {c.errors  > 0 && <span style={{ fontSize: '0.7rem', background: 'rgba(220,50,50,0.08)', border: '1px solid rgba(220,50,50,0.2)',  borderRadius: 4, padding: '1px 7px', color: '#c95050' }}>⚠ {c.errors} err</span>}
                      {c.meanders> 0 && <span style={{ fontSize: '0.7rem', background: 'rgba(100,130,255,0.1)',border: '1px solid rgba(100,130,255,0.3)',borderRadius: 4, padding: '1px 7px', color: '#8090ff' }}>〜 {c.meanders}</span>}
                    </div>

                    {/* Trust score */}
                    {s?.avgTrustScore != null && (
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', minWidth: 60 }}>Trust {Math.round(s.avgTrustScore)}/100</span>
                    )}

                    {/* Batch ID short */}
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem', color: 'var(--text-muted)', minWidth: 60 }}>{batch.batchId.slice(0,8)}</span>
                  </div>

                  {/* Expanded detail */}
                  {isExpanded && s && (
                    <div style={{ padding: '0.75rem 1.25rem 1.25rem', background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: '1rem' }}>

                      {/* Precision quality buckets */}
                      {(s.precision.excellent + s.precision.good + s.precision.fair + s.precision.poor) > 0 && (
                        <div>
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.4rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Closure Precision (passed deeds)</div>
                          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                            {[
                              { label: '≥1:50k Excellent', val: s.precision.excellent, color: 'var(--success)' },
                              { label: '1:10k–50k Good',   val: s.precision.good,      color: '#4ade80' },
                              { label: '1:5k–10k Fair',    val: s.precision.fair,      color: '#c97a00' },
                              { label: '<1:5k Poor',       val: s.precision.poor,      color: 'var(--danger)' },
                            ].filter(b => b.val > 0).map(b => (
                              <div key={b.label} style={{ background: 'var(--bg-card)', border: `1px solid ${b.color}44`, borderRadius: 6, padding: '0.3rem 0.7rem', display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 90 }}>
                                <span style={{ fontSize: '1.1rem', fontWeight: 700, color: b.color }}>{b.val}</span>
                                <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)', textAlign: 'center' }}>{b.label}</span>
                              </div>
                            ))}
                            {s.closure.avgLinearErr > 0 && (
                              <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.3rem 0.7rem', display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 90 }}>
                                <span style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--danger)' }}>{s.closure.avgLinearErr.toFixed(3)} ft</span>
                                <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>avg fail error</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Repair stages */}
                      {s.stages.length > 0 && (
                        <div>
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.4rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Repair Stages Used</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                            {s.stages.map(st => {
                              const stagePct = st.count > 0 ? st.passed / st.count : 0;
                              return (
                                <div key={st.stage} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.74rem' }}>
                                  <div style={{ flex: 1, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }} title={st.stage}>
                                    {st.stage}
                                  </div>
                                  <div style={{ width: 80, height: 5, background: 'var(--bg-card)', borderRadius: 3, overflow: 'hidden' }}>
                                    <div style={{ height: '100%', width: `${stagePct * 100}%`, background: stagePct === 1 ? 'var(--success)' : stagePct > 0 ? '#c97a00' : 'var(--danger)', borderRadius: 3 }} />
                                  </div>
                                  <span style={{ color: 'var(--text-muted)', minWidth: 55, textAlign: 'right' }}>{st.passed}/{st.count}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Failed files */}
                      {s.failedFiles.length > 0 && (
                        <div>
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.4rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Failed / Error Files ({s.failedFiles.length})</div>
                          <div style={{ maxHeight: 160, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                            {s.failedFiles.map(f => (
                              <div key={f.fileName} style={{ display: 'flex', gap: '0.75rem', fontSize: '0.73rem', padding: '0.2rem 0' }}>
                                <span style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--danger)', minWidth: 140 }}>{f.fileName}</span>
                                <span style={{ color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.stage}>{f.stage}</span>
                                {f.linearError > 0 && <span style={{ color: '#c97a00', minWidth: 65, textAlign: 'right' }}>{f.linearError.toFixed(3)} ft</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Spatially Aligned DXF Combiner ── */}
      <div className="card" style={{
        background: 'rgba(9, 14, 26, 0.4)',
        backdropFilter: 'blur(8px)',
        border: '1px solid var(--border)',
        boxShadow: '0 4px 24px rgba(0, 0, 0, 0.15)',
        marginTop: '1.5rem',
      }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <div className="card-title" style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              🌐 Spatially-Aligned DXF Combiner
            </div>
            <button className="btn btn-ghost btn-sm" onClick={fetchRefPoints} style={{ fontSize: '0.72rem' }}>↻ Refresh</button>
          </div>
        </div>

        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Synthesize multiple historical deeds sharing a common <strong>Point of Reference (POR)</strong> into a single, cohesive drawing. Each parcel will be outputted to its own NCS-compliant AutoCAD layer set (e.g. <code style={{ fontSize: '0.65rem' }}>C-PROP-LINE-[ParcelName]</code>) to enable clear CAD toggle states.
          </p>

          <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1, minWidth: '240px' }}>
              <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                Select Active Reference Point (POR)
              </label>
              <select
                value={selectedRefPoint}
                onChange={e => setSelectedRefPoint(e.target.value)}
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.55rem 0.85rem',
                  color: 'var(--text-primary)',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  height: '38px',
                }}
              >
                <option value="">-- Choose Reference Point --</option>
                {distinctRefPoints.map(rp => (
                  <option key={rp} value={rp}>📍 {rp}</option>
                ))}
              </select>
            </div>

            <button
              onClick={handleCombineDxf}
              disabled={combineLoading || deedsForRefPoint.length === 0}
              className="btn btn-primary"
              style={{
                height: '38px',
                padding: '0 1.5rem',
                borderRadius: 'var(--radius-sm)',
                fontWeight: 700,
                fontSize: '0.78rem',
                cursor: deedsForRefPoint.length === 0 ? 'not-allowed' : 'pointer',
                background: deedsForRefPoint.length === 0 ? 'rgba(255,255,255,0.05)' : 'linear-gradient(135deg, #00d4a8 0%, #00b4d8 100%)',
                border: 'none',
                boxShadow: deedsForRefPoint.length === 0 ? 'none' : '0 0 14px rgba(0, 212, 168, 0.3)',
                color: deedsForRefPoint.length === 0 ? 'var(--text-muted)' : '#fff',
              }}
            >
              {combineLoading ? '⏳ Compiling CAD Drawing…' : `📦 Export Combined DXF (${deedsForRefPoint.length} Parcel${deedsForRefPoint.length !== 1 ? 's' : ''})`}
            </button>
          </div>

          {selectedRefPoint && (
            <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#fff' }}>
                Deeds mapped to "{selectedRefPoint}":
              </div>

              {deedsForRefPoint.length === 0 ? (
                <div style={{ padding: '1rem', border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)', textAlign: 'center', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  No successfully closed deeds currently mapped to this reference point in diagnostics database.
                </div>
              ) : (
                <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-card)' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.75rem' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
                        <th style={{ padding: '0.6rem 0.85rem', color: 'var(--text-secondary)' }}>File Name</th>
                        <th style={{ padding: '0.6rem 0.85rem', color: 'var(--text-secondary)' }}>Parcel Name</th>
                        <th style={{ padding: '0.6rem 0.85rem', color: 'var(--text-secondary)', textAlign: 'right' }}>Precision</th>
                        <th style={{ padding: '0.6rem 0.85rem', color: 'var(--text-secondary)', textAlign: 'right' }}>Area (Acres)</th>
                        <th style={{ padding: '0.6rem 0.85rem', color: 'var(--text-secondary)', textAlign: 'center' }}>POR Coordinate</th>
                        <th style={{ padding: '0.6rem 0.85rem', color: 'var(--text-secondary)', textAlign: 'center' }}>POB Coordinate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deedsForRefPoint.map((deed, i) => (
                        <tr key={deed.id || i} style={{ borderBottom: i === deedsForRefPoint.length - 1 ? 'none' : '1px solid var(--border)', transition: 'background 0.2s' }}>
                          <td style={{ padding: '0.6rem 0.85rem', color: '#fff', fontWeight: 500 }}>{deed.fileName}</td>
                          <td style={{ padding: '0.6rem 0.85rem', color: 'var(--text-primary)' }}>{deed.parcelName}</td>
                          <td style={{ padding: '0.6rem 0.85rem', textAlign: 'right', color: 'var(--success)', fontFamily: 'monospace' }}>
                            {deed.precisionRatio ? `1:${Number(deed.precisionRatio).toLocaleString()}` : '—'}
                          </td>
                          <td style={{ padding: '0.6rem 0.85rem', textAlign: 'right', color: 'var(--accent)', fontFamily: 'monospace' }}>
                            {deed.traverseJson ? (JSON.parse(deed.traverseJson).AreaAcres ?? JSON.parse(deed.traverseJson).areaAcres ?? 0).toFixed(4) : '0.0000'}
                          </td>
                          <td style={{ padding: '0.6rem 0.85rem', textAlign: 'center', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                            {deed.referencePointNorthing != null && deed.referencePointEasting != null ? `${deed.referencePointNorthing.toFixed(1)}, ${deed.referencePointEasting.toFixed(1)}` : '—'}
                          </td>
                          <td style={{ padding: '0.6rem 0.85rem', textAlign: 'center', fontFamily: 'monospace', color: 'var(--success)' }}>
                            {deed.pobNorthing != null && deed.pobEasting != null ? `${deed.pobNorthing.toFixed(1)}, ${deed.pobEasting.toFixed(1)}` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {combineMsg && (
            <div style={{
              padding: '0.45rem 0.75rem',
              borderRadius: 'var(--radius-sm)',
              background: combineMsg.startsWith('✓') ? 'rgba(0,212,168,0.08)' : 'rgba(220,50,50,0.1)',
              border: `1px solid ${combineMsg.startsWith('✓') ? 'rgba(0,212,168,0.25)' : 'rgba(220,50,50,0.25)'}`,
              color: combineMsg.startsWith('✓') ? 'var(--success)' : '#dc3232',
              fontSize: '0.75rem',
              fontWeight: 500
            }}>
              {combineMsg}
            </div>
          )}
        </div>
      </div>

      {/* ── Diagnostics Database Case Finder & Heuristics Telemetry ─────────── */}
      <div className="card" style={{ marginTop: '1.5rem' }}>
        <div className="card-header" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem', marginBottom: '1.25rem' }}>
          <div className="card-title">🔍 Heuristics & Diagnostics Case Finder</div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Search historical surveyor deeds & monitor AI-driven correction telemetry (SQLite Sync)
          </span>
        </div>

        {/* 1. Heuristics Telemetry Counters */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem'
        }}>
          {heuristics.map(h => (
            <div key={h.id} style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '0.75rem 1rem',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              gap: '0.2rem'
            }}>
              <div style={{ fontSize: '0.65rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
                {h.problemName}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                {h.solutionApplied}
              </div>
              <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--accent2)', marginTop: '0.25rem' }}>
                {h.successCount} Solved Cases
              </div>
            </div>
          ))}
        </div>

        <div className="divider" style={{ margin: '1rem 0' }} />

        {/* 2. Advanced Search Form Filters */}
        <div style={{
          display: 'flex',
          gap: '1rem',
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          marginBottom: '1.25rem'
        }}>
          <div style={{ flex: 2, minWidth: 200 }}>
            <label className="form-label" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Search Case File or Region</label>
            <input 
              type="text" 
              placeholder="e.g. Cook County or plat_image.png..."
              value={dbQuery}
              onChange={e => setDbQuery(e.target.value)}
              style={{ width: '100%', padding: '0.5rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)' }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 120 }}>
            <label className="form-label" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Status</label>
            <select 
              value={dbStatus} 
              onChange={e => setDbStatus(e.target.value)}
              style={{ width: '100%', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.5rem', color: 'var(--text-primary)' }}
            >
              <option value="">All Statuses</option>
              <option value="PASS">PASS (Closed)</option>
              <option value="FAIL">FAIL (Unclosed)</option>
              <option value="ERROR">ERROR</option>
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label className="form-label" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Max Error Limit (ft)</label>
            <input 
              type="number" 
              step="0.01"
              placeholder="e.g. 0.30"
              value={dbMaxError}
              onChange={e => setDbMaxError(e.target.value)}
              style={{ width: '100%', padding: '0.5rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)' }}
            />
          </div>
          <button className="btn btn-primary" onClick={searchDatabase} style={{ height: '38px', padding: '0 1.25rem' }}>
            {dbLoading ? 'Searching...' : '🔍 Find Cases'}
          </button>
        </div>

        {/* 3. Results Table Grid */}
        <div className="data-table-wrap" style={{ maxHeight: '350px', overflowY: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>File Name</th>
                <th>Region / Parcel</th>
                <th>Calls</th>
                <th>Closure Error</th>
                <th>Precision Ratio</th>
                <th>Status</th>
                <th>Heuristic Repair Stage</th>
                <th>Timestamp</th>
                <th style={{ textAlign: 'center' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {dbLogs.length > 0 ? (
                dbLogs.map(log => (
                  <tr key={log.id}>
                    <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem' }}>{log.fileName}</td>
                    <td>{log.parcelName || '—'}</td>
                    <td>{log.geoCallCount}</td>
                    <td style={{ fontFamily: 'JetBrains Mono' }}>
                      {log.linearError > 900 ? '—' : `${log.linearError.toFixed(4)}'`}
                    </td>
                    <td style={{ fontFamily: 'JetBrains Mono' }}>
                      {log.precisionRatio > 0 ? `1:${log.precisionRatio.toLocaleString()}` : '—'}
                    </td>
                    <td>
                      <span className={`status-badge ${log.status === 'PASS' ? 'pass' : 'fail'}`} style={{ fontSize: '0.65rem', padding: '2px 6px' }}>
                        {log.status}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{log.repairStageUsed || '—'}</td>
                    <td style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{log.timestamp}</td>
                    <td style={{ textAlign: 'center' }}>
                      {log.extractionJson ? (
                        <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'center' }}>
                          <button
                            className="btn btn-sm"
                            onClick={() => loadFromDb(log)}
                            style={{
                              padding: '0.15rem 0.55rem', fontSize: '0.7rem', fontWeight: 600,
                              background: 'rgba(0,212,168,0.1)', border: '1px solid rgba(0,212,168,0.35)',
                              color: 'var(--success)', borderRadius: '4px', cursor: 'pointer',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            📐 Load
                          </button>
                          
                          <button
                            className="btn btn-sm"
                            onClick={() => handleIndividualReprocess(log.fileName)}
                            disabled={reprocessLoading[log.fileName]}
                            style={{
                              padding: '0.15rem 0.55rem', fontSize: '0.7rem', fontWeight: 600,
                              background: log.status === 'PASS' ? 'rgba(255,255,255,0.05)' : 'rgba(255,77,77,0.12)', 
                              border: log.status === 'PASS' ? '1px solid rgba(255,255,255,0.15)' : '1px solid rgba(255,77,77,0.35)',
                              color: log.status === 'PASS' ? 'var(--text-secondary)' : '#ff5a5a', 
                              borderRadius: '4px', cursor: 'pointer',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            {reprocessLoading[log.fileName] ? '⏳ ...' : '🔄 Reprocess'}
                          </button>
                        </div>
                      ) : (
                        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="9" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    No matching cases found in the diagnostics database. Run new batch extractions to save records.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showPrint && results && (
        (() => {
          const r = results.results[activeIdx];
          if (!r) return null;
          const courses  = (r.extraction?.courses || []);
          const stations = (r.traverse?.stations || []);
          const adjusted = (r.traverse?.adjustedStations || []);
          const { n: activePobN, e: activePobE } = getPobCoordinates();
          return (
            <PrintBlueprint
              key={`${activeIdx}_${r.fileName}_${r.traverse?.stations?.length || 0}_${r.traverse?.closure?.linearError || 0}`}
              courses={courses}
              stations={stations}
              adjusted={adjusted}
              units="Feet"
              area={r.traverse?.areaAcres ?? 0}
              perimeter={r.traverse?.perimeter ?? 0}
              pob={{ northing: parseFloat(activePobN), easting: parseFloat(activePobE) }}
              initialLegalDescription={r.legalDescription?.legalDescription || ''}
              originalCourses={r.originalExtraction?.courses || null}
              originalLegalDescription={''}
              closure={r.traverse?.closure}
              onClose={() => setShowPrint(false)}
            />
          );
        })()
      )}

      {browserOpen && (
        <FolderBrowserModal
          onClose={() => setBrowserOpen(false)}
          onSelect={(selectedPath) => {
            setFolderPath(selectedPath);
            setFolderManifest(null);
          }}
          initialPath={folderPath}
        />
      )}
    </div>
  );
}
