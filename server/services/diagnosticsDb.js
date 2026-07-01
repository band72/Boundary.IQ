/**
 * diagnosticsDb.js — Backward-compatible barrel re-export.
 *
 * All existing `import * as db from '../services/diagnosticsDb.js'` calls
 * in routes and middleware continue to work without any changes.
 *
 * Internal implementation has been split into domain modules under services/db/:
 *   db/core.js          — connection, migrations, now(), mapDeedLog()
 *   db/deedLogs.js      — DeedLog and BatchRun CRUD
 *   db/users.js         — user management, password hashing, usage tracking
 *   db/sessions.js      — session create/get/revoke/purge
 *   db/subscriptions.js — Stripe subscription records
 *   db/audit.js         — audit log writes and reads
 *   db/invites.js       — invite token management
 *
 * To migrate a file to the new granular imports:
 *   import { saveDeedLog, findSolvedCase } from './db/deedLogs.js';
 *   import { createUser, verifyUser } from './db/users.js';
 *   // etc.
 */

export { init, switchDbPath, getDbPath, now, getDb, mapDeedLog } from './db/core.js';

export {
  saveBatchRun, getRecentBatchRuns, getBatchStats, getRecentBatchesWithStats,
  saveDeedLog, saveCorrectedDeed, searchDeedLogs,
  findSolvedCase, findSkippedCase,
  purgeStaleCache, purgeOldLogs, clearFailedCache, clearAllCache,
  getFailedFileNames, getFailedDeedList, getDeedDetail, getSolutionSteps, getDatabaseStats,
  getHeuristicTracking, incrementHeuristic,
  getDeedsByReferencePoint, getDistinctReferencePoints,
} from './db/deedLogs.js';

export {
  hashPassword, verifyPassword,
  createUser, verifyUser, findUserByUsername,
  getAllUsers, getUserById, updateUserRole, updateUserPlan,
  touchLastLogin, getUserCount, deleteUser, updateProfile, updatePassword,
  forceResetPassword, verifyPasswordOnly, checkForceReset,
  FREE_DAILY_DEED_LIMIT,
  getDailyUsage, incrementDailyUsage, checkDailyLimit,
  getUserDailyStats, getSystemStats,
} from './db/users.js';

export {
  createSession, getSession, deleteSession, purgeExpiredSessions,
  getUserSessions, revokeSession, revokeAllUserSessions, revokeAllUserSessionsExcept,
} from './db/sessions.js';

export {
  upsertSubscription, getSubscriptionByUser,
  getSubscriptionByStripeCustomer, getSubscriptionByStripeSubscription,
  getAllSubscriptions, getRevenueStats, adminSetPlan, adminCancelSubscription,
} from './db/subscriptions.js';

export { logAudit, getAuditLog } from './db/audit.js';

export {
  createInviteToken, getInviteToken, redeemInviteToken,
  listInvites, revokeInviteToken,
} from './db/invites.js';

export { getUserSettings, saveUserSettings } from './db/userSettings.js';

export { logTokenUsage, getUserTokenStats } from './db/tokenUsage.js';

export { getAllPlanSettings, getPlanSettings, updatePlanSettings } from './db/planSettings.js';

