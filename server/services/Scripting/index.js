// ── BoundaryIQ Scripting Engine ──────────────────────────────────────────────
// Barrel export: single entry point for all COGO / traversal / legal-description
// engine modules.  Consumers can import the whole engine:
//
//   import * as Scripting from '../services/Scripting/index.js';
//   Scripting.traverse.computeTraverse(courses);
//
// Or import individual modules directly:
//   import * as traverseSvc from '../services/Scripting/traverse.js';
// ─────────────────────────────────────────────────────────────────────────────

export * as traverse        from './traverse.js';
export * as bearingParser   from './bearingParser.js';
export * as repair          from './repair.js';
export * as legalWriter     from './legalWriter.js';
export * as deedTextSolver  from './deedTextSolver.js';
export * as chainedResolver from './chainedTraverseResolver.js';
export * as agentSystem     from './agentSystem.js';
