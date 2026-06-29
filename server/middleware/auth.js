import { getSession, getUserSettings } from '../services/diagnosticsDb.js';
import { userSettingsStore } from '../services/db/context.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger('auth');

// Plan hierarchy: free < pro < enterprise < admin
const PLAN_RANK = { free: 0, pro: 1, enterprise: 2, admin: 99 };
const ROLE_RANK = { user: 0, pro: 1, admin: 99 };

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURIComponent(parts.join('='));
  });
  return list;
}

/**
 * Express middleware to validate session token via Authorization header or Cookie.
 * Attaches the authenticated user object to req.user.
 */
export function requireAuth(req, res, next) {
  try {
    let token = null;
    const authHeader = req.headers.authorization;

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (req.headers.cookie) {
      const cookies = parseCookies(req.headers.cookie);
      token = cookies.boundaryiq_auth_token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Access denied. Authentication token not found in cookies or headers.' });
    }

    const sessionUser = getSession(token);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Access denied. Session has expired or is invalid.' });
    }

    // Attach user metadata to request
    req.user = {
      id: sessionUser.userId,
      username: sessionUser.username,
      role: sessionUser.role,
      plan: sessionUser.plan || 'free',
    };

    const userSettings = getUserSettings(sessionUser.userId) || {};
    const contextSettings = {
      userId: sessionUser.userId,
      activeProvider: userSettings.ActiveProvider || undefined,
      activeModel: userSettings.ActiveModel || undefined,
      openaiBaseUrl: userSettings.OpenaiBaseUrl || undefined,
      allowApiFallback: userSettings.AllowApiFallback !== undefined ? (userSettings.AllowApiFallback === 1) : undefined,
      enforceNoSelfIntersection: userSettings.EnforceNoSelfIntersection !== undefined ? (userSettings.EnforceNoSelfIntersection === 1) : undefined,
      geminiApiKey: userSettings.GeminiApiKey || undefined,
      openaiApiKey: userSettings.OpenaiApiKey || undefined,
      mapPanSensitivity: userSettings.MapPanSensitivity !== undefined ? userSettings.MapPanSensitivity : undefined,
    };

    userSettingsStore.run(contextSettings, () => {
      next();
    });
  } catch (err) {
    log.error({ err: err.message }, 'Authentication middleware error');
    return res.status(500).json({ error: 'Internal server error during authentication.' });
  }
}

/**
 * Middleware to enforce role restrictions (e.g. admin-only routes).
 */
export function requireRole(allowedRoles = []) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Access denied. Authenticated user session required.' });
    }

    const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    if (roles.length > 0 && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access forbidden. Insufficient permissions for this resource.' });
    }

    next();
  };
}

/**
 * Middleware to enforce minimum subscription plan.
 * Admins always pass. Plan rank: free < pro < enterprise.
 */
export function requirePlan(minPlan = 'pro') {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Access denied. Authentication required.' });
    }

    // Admins bypass all plan gates
    if (req.user.role === 'admin') return next();

    const userRank = PLAN_RANK[req.user.plan] ?? 0;
    const requiredRank = PLAN_RANK[minPlan] ?? 1;

    if (userRank < requiredRank) {
      return res.status(402).json({
        error: 'Subscription required.',
        code: 'UPGRADE_REQUIRED',
        requiredPlan: minPlan,
        currentPlan: req.user.plan,
        upgradeUrl: '/billing',
      });
    }

    next();
  };
}

/**
 * Middleware that checks daily deed solve limits for free users.
 * Attaches usage info to req.usage for downstream use.
 */
export function trackDeedUsage(req, res, next) {
  if (!req.user) return next();
  // Import lazily to avoid circular deps
  import('../services/diagnosticsDb.js').then(({ checkDailyLimit, incrementDailyUsage }) => {
    const limit = checkDailyLimit(req.user.id, req.user.plan, req.user.role);
    req.usage = limit;

    if (!limit.allowed) {
      return res.status(429).json({
        error: 'Daily deed solve limit reached.',
        code: 'DAILY_LIMIT_REACHED',
        used: limit.used,
        limit: limit.limit,
        upgradeUrl: '/billing',
        message: `You've used ${limit.used}/${limit.limit} free deed solves today. Upgrade to Pro for unlimited solves.`,
      });
    }

    // Increment usage count before processing
    incrementDailyUsage(req.user.id);
    next();
  }).catch(err => {
    log.error({ err: err.message }, 'trackDeedUsage error');
    next(); // Don't block if tracking fails
  });
}
