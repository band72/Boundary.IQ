import { getSession } from '../services/diagnosticsDb.js';

/**
 * Express middleware to validate session token via Authorization header.
 * Attaches the authenticated user object to req.user.
 */
export function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Access denied. Authorization header required.' });
    }

    const token = authHeader.substring(7);

    if (!token) {
      return res.status(401).json({ error: 'Access denied. Authorization token not found.' });
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
    };

    next();
  } catch (err) {
    console.error('Authentication middleware error:', err.message);
    return res.status(500).json({ error: 'Internal server error during authentication.' });
  }
}

/**
 * Optional middleware to enforce role restrictions (e.g. admin-only routes).
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
