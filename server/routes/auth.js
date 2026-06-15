import { Router } from 'express';
import {
  createUser, verifyUser, createSession, getSession, deleteSession,
  findUserByUsername, getAllUsers, getUserById, updateUserRole, updateUserPlan,
  touchLastLogin,
  // New functions
  deleteUser, updateProfile, updatePassword, forceResetPassword,
  verifyPasswordOnly, checkForceReset,
  getUserSessions, revokeSession, revokeAllUserSessions, revokeAllUserSessionsExcept,
  logAudit, getAuditLog,
  createInviteToken, getInviteToken, redeemInviteToken, listInvites, revokeInviteToken,
  getUserDailyStats, getSystemStats,
  // Order management
  getAllSubscriptions, getRevenueStats, adminSetPlan, adminCancelSubscription,
} from '../services/diagnosticsDb.js';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  sendWelcomeEmail, sendPasswordChangedEmail, sendTempPasswordEmail,
  sendPlanChangedEmail, sendInviteEmail,
} from '../services/emailService.js';

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────────

const getIp = (req) => req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
const getUA = (req) => req.headers['user-agent'] || null;

// Lazily-constructed OAuth2Client
let _googleClient = null;
function getGoogleClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return null;
  if (!_googleClient) _googleClient = new OAuth2Client(clientId);
  return _googleClient;
}

// Invite-only mode: set INVITE_ONLY=true in .env
const isInviteOnly = () => process.env.INVITE_ONLY === 'true';

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { username, password, inviteToken } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Invite-only gate
    if (isInviteOnly()) {
      if (!inviteToken) {
        return res.status(403).json({ error: 'Registration is invite-only. Please use a valid invite link.', inviteOnly: true });
      }
      const invite = getInviteToken(inviteToken);
      if (!invite || invite.used || invite.expired) {
        return res.status(403).json({ error: 'Invite link is invalid or has expired.' });
      }
    }

    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters long' });
    if (password.length < 6)        return res.status(400).json({ error: 'Password must be at least 6 characters long' });

    const user = createUser(trimmedUsername, password);
    const token = createSession(user.id, { ipAddress: getIp(req), userAgent: getUA(req) });

    // Redeem invite if provided
    if (inviteToken) {
      redeemInviteToken(inviteToken, user.id);
    }

    logAudit({ userId: user.id, actorId: user.id, action: 'register', ipAddress: getIp(req) });
    sendWelcomeEmail({ to: user.username, username: user.username, plan: user.plan }).catch(() => {});

    return res.status(201).json({ token, username: user.username, role: user.role, plan: user.plan || 'free' });
  } catch (err) {
    console.error('Registration error:', err.message);
    return res.status(400).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    const user = verifyUser(username.trim(), password);
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    touchLastLogin(user.id);
    const token = createSession(user.id, { ipAddress: getIp(req), userAgent: getUA(req) });

    const forceReset = checkForceReset(user.id);
    logAudit({ userId: user.id, actorId: user.id, action: 'login', ipAddress: getIp(req) });

    return res.json({ token, username: user.username, role: user.role, plan: user.plan || 'free', forcePasswordReset: forceReset });
  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    if (token) deleteSession(token);
    return res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    if (!token) return res.status(401).json({ error: 'Authorization token not found' });

    const sessionUser = getSession(token);
    if (!sessionUser) return res.status(401).json({ error: 'Session has expired or is invalid' });

    const forceReset = checkForceReset(sessionUser.userId);
    return res.json({ id: sessionUser.userId, username: sessionUser.username, role: sessionUser.role, plan: sessionUser.plan || 'free', forcePasswordReset: forceReset });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/invite-only
router.get('/invite-only', (req, res) => res.json({ inviteOnly: isInviteOnly() }));

// ── Self-service: my account ───────────────────────────────────────────────────

// PUT /api/auth/me/password
router.put('/me/password', requireAuth, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const valid = verifyPasswordOnly(req.user.id, currentPassword);
    if (!valid) return res.status(403).json({ error: 'Current password is incorrect' });

    updatePassword(req.user.id, newPassword);
    logAudit({ userId: req.user.id, actorId: req.user.id, action: 'password_change', ipAddress: getIp(req) });
    sendPasswordChangedEmail({ to: req.user.username, username: req.user.username }).catch(() => {});

    return res.json({ success: true, message: 'Password updated. All other sessions have been revoked.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/me/profile
router.put('/me/profile', requireAuth, (req, res) => {
  try {
    const { displayName } = req.body;
    updateProfile(req.user.id, { displayName });
    logAudit({ userId: req.user.id, actorId: req.user.id, action: 'profile_update', ipAddress: getIp(req) });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me/sessions
router.get('/me/sessions', requireAuth, (req, res) => {
  try {
    const sessions = getUserSessions(req.user.id);
    return res.json({ sessions });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/me/sessions/:token — revoke a specific session
router.delete('/me/sessions/:token', requireAuth, (req, res) => {
  try {
    revokeSession(req.params.token);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/me/sessions — revoke all OTHER sessions (keep current)
router.delete('/me/sessions', requireAuth, (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const currentToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    const revoked = revokeAllUserSessionsExcept(req.user.id, currentToken);
    logAudit({ userId: req.user.id, actorId: req.user.id, action: 'revoke_other_sessions', detail: { revoked }, ipAddress: getIp(req) });
    return res.json({ success: true, revoked });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Google login ───────────────────────────────────────────────────────────────

// POST /api/auth/google-login
router.post('/google-login', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Google credential token is required' });

    const googleClient = getGoogleClient();
    let payload;

    if (googleClient) {
      try {
        const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
        payload = ticket.getPayload();
      } catch {
        return res.status(401).json({ error: 'Invalid or expired Google token.' });
      }
    } else if (process.env.NODE_ENV !== 'production') {
      try {
        const parts = credential.split('.');
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
        payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'Malformed simulator credential.' });
      }
    } else {
      return res.status(503).json({ error: 'Google Sign-In is not configured.' });
    }

    const email = payload?.email;
    if (!email) return res.status(400).json({ error: 'Email not found in Google token' });
    if (!payload.email_verified) return res.status(403).json({ error: 'Google account email is not verified' });

    let user = findUserByUsername(email);
    if (!user) {
      user = createUser(email, crypto.randomBytes(32).toString('hex'));
      sendWelcomeEmail({ to: user.username, username: user.username, plan: user.plan }).catch(() => {});
    }

    touchLastLogin(user.id);
    const token = createSession(user.id, { ipAddress: getIp(req), userAgent: getUA(req) });
    logAudit({ userId: user.id, actorId: user.id, action: 'google_login', ipAddress: getIp(req) });

    return res.json({ token, username: user.username, role: user.role, plan: user.plan || 'free' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Admin: User Management ─────────────────────────────────────────────────────

// GET /api/auth/users
router.get('/users', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    const users = getAllUsers();
    return res.json({ users, total: users.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/users/:id
router.get('/users/:id', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    const user = getUserById(parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    const stats = getUserDailyStats(user.id, 30);
    const sessions = getUserSessions(user.id);
    return res.json({ ...user, recentStats: stats, activeSessions: sessions.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/users/:id/role
router.post('/users/:id/role', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { role } = req.body;
    if (!role) return res.status(400).json({ error: 'role is required' });
    if (userId === req.user.id && role !== 'admin') return res.status(400).json({ error: 'You cannot change your own admin role.' });
    const target = getUserById(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    updateUserRole(userId, role);
    logAudit({ userId, actorId: req.user.id, action: 'role_change', detail: { from: target.role, to: role }, ipAddress: getIp(req) });
    return res.json({ success: true, userId, role });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// POST /api/auth/users/:id/plan
router.post('/users/:id/plan', requireAuth, requireRole(['admin']), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { plan } = req.body;
    if (!plan) return res.status(400).json({ error: 'plan is required' });
    const target = getUserById(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    updateUserPlan(userId, plan);
    logAudit({ userId, actorId: req.user.id, action: 'plan_change', detail: { from: target.plan, to: plan }, ipAddress: getIp(req) });
    sendPlanChangedEmail({ to: target.username, username: target.username, plan }).catch(() => {});
    return res.json({ success: true, userId, plan });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// DELETE /api/auth/users/:id — admin only: delete user
router.delete('/users/:id', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (userId === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account from this panel.' });
    const target = getUserById(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    deleteUser(userId);
    logAudit({ actorId: req.user.id, action: 'delete_user', target: target.username, ipAddress: getIp(req) });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/users/:id/reset-password — admin: force password reset
router.post('/users/:id/reset-password', requireAuth, requireRole(['admin']), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const target = getUserById(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const tempPw = forceResetPassword(userId);
    logAudit({ userId, actorId: req.user.id, action: 'force_password_reset', ipAddress: getIp(req) });
    // Send email if we have an address (username might be email)
    if (target.username.includes('@')) {
      sendTempPasswordEmail({ to: target.username, username: target.username, tempPassword: tempPw }).catch(() => {});
    }
    return res.json({ success: true, tempPassword: tempPw, message: 'Password reset. User sessions revoked. Temp password shown once.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/users/:id/sessions — admin: view a user's sessions
router.get('/users/:id/sessions', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    const sessions = getUserSessions(parseInt(req.params.id));
    return res.json({ sessions });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/users/:id/sessions — admin: revoke all sessions for a user
router.delete('/users/:id/sessions', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const revoked = revokeAllUserSessions(userId);
    logAudit({ userId, actorId: req.user.id, action: 'revoke_sessions', detail: { revoked }, ipAddress: getIp(req) });
    return res.json({ success: true, revoked });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/users/:id/stats — admin: usage stats for a user
router.get('/users/:id/stats', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    const stats = getUserDailyStats(parseInt(req.params.id), 30);
    return res.json({ stats });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Admin: Audit Log ──────────────────────────────────────────────────────────

// GET /api/auth/audit-log
router.get('/audit-log', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    const { limit = 100, offset = 0, userId, action } = req.query;
    const entries = getAuditLog({ limit: parseInt(limit), offset: parseInt(offset), userId: userId ? parseInt(userId) : null, action: action || null });
    return res.json({ entries, count: entries.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Admin: System stats ────────────────────────────────────────────────────────

// GET /api/auth/system-stats
router.get('/system-stats', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    return res.json(getSystemStats());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Invite Tokens ─────────────────────────────────────────────────────────────

// POST /api/auth/invite — admin: create invite
router.post('/invite', requireAuth, requireRole(['admin']), async (req, res) => {
  try {
    const { email, note, expiresInHours = 72 } = req.body;
    const token = createInviteToken({ createdByUserId: req.user.id, email, note, expiresInHours });
    const inviteUrl = `${process.env.FRONTEND_URL || 'http://localhost:5174'}/?invite=${token}`;

    if (email) {
      sendInviteEmail({ to: email, inviteUrl, inviterUsername: req.user.username, note }).catch(() => {});
    }

    logAudit({ actorId: req.user.id, action: 'create_invite', target: email || 'open', ipAddress: getIp(req) });
    return res.json({ success: true, token, inviteUrl, email: email || null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/invite/:token — validate invite (public, no auth)
router.get('/invite/:token', (req, res) => {
  try {
    const invite = getInviteToken(req.params.token);
    if (!invite) return res.status(404).json({ valid: false, reason: 'Token not found' });
    if (invite.used) return res.status(410).json({ valid: false, reason: 'Token already used' });
    if (invite.expired) return res.status(410).json({ valid: false, reason: 'Token expired' });
    return res.json({ valid: true, email: invite.email, createdByUsername: invite.createdByUsername });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/invites — admin: list all invites
router.get('/invites', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    const invites = listInvites();
    return res.json({ invites });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/invites/:token — admin: revoke an invite
router.delete('/invites/:token', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    revokeInviteToken(req.params.token);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Order / Subscription Management (admin) ────────────────────────────────────

// GET /api/auth/orders — list all subscriptions with user info and usage
router.get('/orders', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    const orders = getAllSubscriptions();
    const revenue = getRevenueStats();
    return res.json({ orders, revenue });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/orders/:userId/plan — admin manually set a user's plan
router.put('/orders/:userId/plan', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    const { plan } = req.body;
    const VALID_PLANS = ['free', 'pro', 'enterprise'];
    if (!VALID_PLANS.includes(plan)) {
      return res.status(400).json({ error: `Invalid plan. Must be one of: ${VALID_PLANS.join(', ')}` });
    }
    const userId = parseInt(req.params.userId);
    if (userId === req.user.id && plan !== 'admin') {
      // Allow admin self-plan-change only carefully
    }
    adminSetPlan(userId, plan, req.user.id);
    // Send plan changed email if user has email
    const user = getUserById(userId);
    if (user?.Email || user?.username) {
      sendPlanChangedEmail({ to: user.Email || user.username, username: user.username, plan }).catch(() => {});
    }
    return res.json({ success: true, userId, plan });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/orders/:userId — admin cancel subscription (downgrade to free)
router.delete('/orders/:userId', requireAuth, requireRole(['admin']), (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    adminCancelSubscription(userId, req.user.id);
    return res.json({ success: true, userId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/forgot-password — self-service password reset (public, no auth)
// Anti-enumeration: always returns same message regardless of whether user exists.
router.post('/forgot-password', async (req, res) => {
  const successResponse = {
    success: true,
    message: 'If that username exists and has a registered email, a temporary password has been sent.',
  };
  try {
    const { username } = req.body;
    if (!username?.trim()) return res.status(400).json({ error: 'Username is required.' });

    const user = findUserByUsername(username.trim());
    if (!user) {
      await new Promise(r => setTimeout(r, 300 + Math.random() * 200)); // timing-safe
      return res.json(successResponse);
    }

    const userFull = getUserById(user.id);
    const email = userFull?.Email || null;

    // Generate temp password — sets ForceResetPw=1 and revokes all sessions
    const tempPw = forceResetPassword(user.id, user.id);

    if (email || user.username) {
      sendTempPasswordEmail({ to: email || user.username, username: user.username, tempPassword: tempPw }).catch(e =>
        console.warn('[forgot-password] Email failed:', e.message)
      );
    } else {
      // No email on file — log the temp password to audit log so admin can retrieve it
      console.warn(`[forgot-password] No email for user ${user.username}. Temp PW: ${tempPw}`);
    }

    logAudit({
      userId: user.id,
      actorId: user.id,
      action: 'forgot_password',
      target: `userId=${user.id}`,
      detail: { status: email ? 'email_sent' : 'no_email_logged' }
    });
    return res.json(successResponse);
  } catch (err) {
    console.error('[forgot-password]', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
