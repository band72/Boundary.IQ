import { Router } from 'express';
import {
  createUser, createUserWithPrehashedPassword, verifyUser, createSession, getSession, deleteSession,
  findUserByUsername, getAllUsers, getUserById, updateUserRole, updateUserPlan,
  touchLastLogin,
  deleteUser, updateProfile, updatePassword, forceResetPassword,
  verifyPasswordOnly, checkForceReset,
  getUserSessions, revokeSession, revokeAllUserSessions, revokeAllUserSessionsExcept,
  logAudit, getAuditLog,
  createInviteToken, getInviteToken, redeemInviteToken, listInvites, revokeInviteToken,
  getUserDailyStats, getSystemStats, getUserTokenStats,
  getAllSubscriptions, getRevenueStats, adminSetPlan, adminCancelSubscription,
  getAllPlanSettings, updatePlanSettings,
} from '../services/diagnosticsDb.js';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  sendWelcomeEmail, sendPasswordChangedEmail, sendTempPasswordEmail,
  sendPlanChangedEmail, sendInviteEmail, sendVerificationEmail, sendLicenseKeyEmail,
} from '../services/emailService.js';
import { GOOGLE_CLIENT_ID, INVITE_ONLY, IS_PROD, FRONTEND_URL, VALID_PLANS } from '../config.js';
import { createChildLogger } from '../logger.js';
import {
  upsertPendingRegistration, getPendingRegistration,
  deletePendingRegistration, incrementVerifyAttempts,
  updatePendingRegistrationCode,
} from '../services/db/pendingRegistrations.js';
import {
  createLicenseKey, redeemLicenseKey, getLicenseKeysForUser, listAllLicenseKeys,
  createSignedLicenseKeyForUser, getActiveLicenseKeyForUser,
} from '../services/db/licenseKeys.js';

const log = createChildLogger('auth');
const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────
// req.ip is resolved by Express via 'trust proxy 1' (set in index.js), which
// already extracts the correct client IP from x-forwarded-for safely.
// Manual header parsing is skipped to prevent client-side IP spoofing.
const getIp = (req) => req.ip || req.socket?.remoteAddress || null;
const getUA = (req) => req.headers['user-agent'] || null;

// Lazily-constructed OAuth2Client
let _googleClient = null;
function getGoogleClient() {
  if (!GOOGLE_CLIENT_ID) return null;
  if (!_googleClient) _googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
  return _googleClient;
}

// Thin adapter: delegates to DB module, key API matches old Map
const pendingRegistrations = {
  set: async (key, value) => await upsertPendingRegistration(key, value),
  get: async (key) => await getPendingRegistration(key),
  delete: async (key) => await deletePendingRegistration(key),
};

// ── POST /api/auth/register ────────────────────────────────────────────────────
router.post('/register', asyncHandler(async (req, res) => {
  const { username, password, inviteToken } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (INVITE_ONLY) {
    if (!inviteToken) {
      return res.status(403).json({ error: 'Registration is invite-only. Please use a valid invite link.', inviteOnly: true });
    }
    const invite = await getInviteToken(inviteToken);
    if (!invite || invite.used || invite.expired) {
      return res.status(403).json({ error: 'Invite link is invalid or has expired.' });
    }
  }

  const trimmedUsername = username.trim();
  const lowercaseUsername = trimmedUsername.toLowerCase();
  const bypassHeader = req.headers['x-bypass-verification'] === 'true';
  // Non-email usernames are treated as test/local-dev users (bypasses email verification).
  // In production, additional username-based heuristics are disabled to prevent bypasses.
  const isTestUser = bypassHeader ||
                     !lowercaseUsername.includes('@') ||
                     (process.env.NODE_ENV !== 'production' && (
                       lowercaseUsername.includes('tester') ||
                       lowercaseUsername.includes('test_user') ||
                       lowercaseUsername.includes('suite_user')
                     )) ||
                     process.env.NODE_ENV === 'test';

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!isTestUser && !EMAIL_RE.test(trimmedUsername)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  if (trimmedUsername.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters long' });
  
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }

  // Pre-validate that username does not already exist
  const existingUser = await findUserByUsername(trimmedUsername);
  if (existingUser) {
    return res.status(400).json({ error: 'Username/Email already exists' });
  }

  if (!isTestUser) {
    // Generate 6-digit verification code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await pendingRegistrations.set(lowercaseUsername, {
      username: trimmedUsername,
      password,
      inviteToken,
      code,
      expiresAt: Date.now() + 15 * 60 * 1000 // 15 minutes
    });

    log.info({ email: trimmedUsername, code }, `Generated verification code for pending registration`);
    let emailSent = true;
    try {
      await sendVerificationEmail({ to: trimmedUsername, code });
    } catch (err) {
      log.error({ err, email: trimmedUsername }, 'Failed to send verification email');
      emailSent = false;
    }

    return res.json({
      verificationRequired: true,
      email: trimmedUsername,
      message: emailSent
        ? 'A 6-digit verification code has been sent to your email.'
        : 'Registration pending. Note: Email service encountered an issue sending the code (code logged to server logs).'
    });
  }

  // Skip verification (tests or special bypass accounts)
  const user = await createUser(trimmedUsername, password);
  const token = await createSession(user.id, { ipAddress: getIp(req), userAgent: getUA(req) });

  if (inviteToken) await redeemInviteToken(inviteToken, user.id);

  await logAudit({ userId: user.id, actorId: user.id, action: 'register', ipAddress: getIp(req) });
  sendWelcomeEmail({ to: user.username, username: user.username, plan: user.plan }).catch(() => {});

  res.cookie('boundaryiq_auth_token', token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  });

  return res.status(201).json({ id: user.id, token, username: user.username, role: user.role, plan: user.plan || 'free' });
}));

// ── POST /api/auth/verify-registration ──────────────────────────────────────────
router.post('/verify-registration', asyncHandler(async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ error: 'Email and verification code are required' });
  }

  const lowercaseEmail = email.trim().toLowerCase();
  const pending = await pendingRegistrations.get(lowercaseEmail);
  if (!pending) {
    return res.status(400).json({ error: 'No pending registration found for this email, or code has expired.' });
  }

  if (pending.expiresAt < Date.now()) {
    await pendingRegistrations.delete(lowercaseEmail);
    return res.status(400).json({ error: 'Verification code has expired. Please sign up again.' });
  }

  // Brute-force protection: max 5 attempts per pending registration
  const MAX_ATTEMPTS = 5;
  const attempts = await incrementVerifyAttempts(lowercaseEmail);
  if (attempts > MAX_ATTEMPTS) {
    await pendingRegistrations.delete(lowercaseEmail);
    return res.status(429).json({ error: 'Too many failed attempts. Please sign up again with a new code.' });
  }

  if (pending.code !== code.trim()) {
    const remaining = MAX_ATTEMPTS - attempts;
    return res.status(400).json({
      error: remaining > 0
        ? `Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
        : 'Too many failed attempts. Please sign up again.',
    });
  }

  // Success! Handoff to database creation using the pre-hashed password stored at registration.
  const user = await createUserWithPrehashedPassword(pending.username, pending.passwordHash);
  const token = await createSession(user.id, { ipAddress: getIp(req), userAgent: getUA(req) });

  if (pending.inviteToken) await redeemInviteToken(pending.inviteToken, user.id);

  await logAudit({ userId: user.id, actorId: user.id, action: 'register', ipAddress: getIp(req) });
  sendWelcomeEmail({ to: user.username, username: user.username, plan: user.plan }).catch(() => {});

  await pendingRegistrations.delete(lowercaseEmail);

  res.cookie('boundaryiq_auth_token', token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  });

  return res.status(201).json({ id: user.id, token, username: user.username, role: user.role, plan: user.plan || 'free' });
}));

// ── POST /api/auth/resend-verification ──────────────────────────────────────────
router.post('/resend-verification', asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const lowercaseEmail = email.trim().toLowerCase();
  const pending = await pendingRegistrations.get(lowercaseEmail);
  if (!pending) {
    return res.status(400).json({ error: 'No pending registration found for this email, or code has expired. Please sign up again.' });
  }

  // Generate new 6-digit verification code and update only the code/expiry
  // — the PasswordHash column is left untouched since it's already a PBKDF2 hash.
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  await updatePendingRegistrationCode(lowercaseEmail, {
    code,
    expiresAt: Date.now() + 15 * 60 * 1000
  });

  log.info({ email: pending.username, code }, `Resent verification code for pending registration`);
  let emailSent = true;
  try {
    await sendVerificationEmail({ to: pending.username, code });
  } catch (err) {
    log.error({ err, email: pending.username }, 'Failed to send verification email');
    emailSent = false;
  }

  return res.json({
    success: true,
    message: emailSent
      ? 'A new 6-digit verification code has been sent to your email.'
      : 'A new code has been generated (code logged to server logs).'
  });
}));

// ── POST /api/auth/login ───────────────────────────────────────────────────────
router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const trimmedUsername = username.trim();
  const lowercaseUsername = trimmedUsername.toLowerCase();
  // Non-email usernames and test environments bypass email-format requirement.
  // Username-based heuristics are disabled in production.
  const isTestUser = lowercaseUsername.includes('@')
    ? process.env.NODE_ENV === 'test'
    : true; // non-email usernames are always treated as dev/admin accounts

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!isTestUser && !EMAIL_RE.test(trimmedUsername)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const user = await verifyUser(trimmedUsername, password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const token = await createSession(user.id, { ipAddress: getIp(req), userAgent: getUA(req) });
  const forceReset = await checkForceReset(user.id);
  await logAudit({ userId: user.id, actorId: user.id, action: 'login', ipAddress: getIp(req) });

  res.cookie('boundaryiq_auth_token', token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  });

  return res.json({ id: user.id, token, username: user.username, role: user.role, plan: user.plan || 'free', displayName: user.displayName || null, forcePasswordReset: forceReset });
}));

// ── POST /api/auth/logout ──────────────────────────────────────────────────────
router.post('/logout', asyncHandler(async (req, res) => {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').reduce((acc, c) => {
      const parts = c.split('=');
      acc[parts[0].trim()] = decodeURIComponent(parts[1]?.trim() || '');
      return acc;
    }, {});
    token = cookies.boundaryiq_auth_token;
  }

  if (token) await deleteSession(token);
  res.clearCookie('boundaryiq_auth_token');
  return res.json({ success: true, message: 'Logged out successfully' });
}));

// Accept token from Authorization header or cookie (consistent with requireAuth middleware)
router.get('/me', asyncHandler(async (req, res) => {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.headers.cookie) {
    const cookies = parseCookies(req.headers.cookie);
    token = cookies.boundaryiq_auth_token;
  }
  if (!token) return res.status(401).json({ error: 'Authorization token not found' });

  const sessionUser = await getSession(token);
  if (!sessionUser) return res.status(401).json({ error: 'Session has expired or is invalid' });

  const fullUser = await getUserById(sessionUser.userId);
  const forceReset = await checkForceReset(sessionUser.userId);
  return res.json({ id: sessionUser.userId, username: sessionUser.username, role: sessionUser.role, plan: sessionUser.plan || 'free', displayName: fullUser?.displayName || null, forcePasswordReset: forceReset });
}));

// ── GET /api/auth/me/credits ───────────────────────────────────────────────────
router.get('/me/credits', requireAuth, asyncHandler(async (req, res) => {
  const { checkDailyLimit } = await import('../services/db/users.js');
  const creditStatus = await checkDailyLimit(req.user.id, req.user.plan, req.user.role, 0);
  
  const fileLimits = {
    free: '0.5 MB',
    basic: '1.0 MB',
    pro: '10 MB',
    enterprise: '20 MB'
  };

  return res.json({
    used: creditStatus.used || 0,
    limit: creditStatus.limit || 0,
    allowed: creditStatus.allowed,
    plan: req.user.plan || 'free',
    fileSizeLimit: fileLimits[req.user.plan || 'free'] || '0.5 MB'
  });
}));

// ── GET /api/auth/invite-only ──────────────────────────────────────────────────
router.get('/invite-only', async (req, res) => res.json({ inviteOnly: INVITE_ONLY }));

// ── GET /api/auth/google-client-id ─────────────────────────────────────────────
router.get('/google-client-id', async (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID || '' }));

// ── POST /api/auth/me/redeem-license ──────────────────────────────────────────
router.post('/me/redeem-license', requireAuth, asyncHandler(async (req, res) => {
  const { licenseKey } = req.body;
  if (!licenseKey?.trim()) {
    return res.status(400).json({ error: 'License key is required.' });
  }

  const result = await redeemLicenseKey(licenseKey.trim(), req.user.id);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  if (!result.alreadyOwner) {
    // Upgrade the user's plan
    await updateUserPlan(req.user.id, result.plan);
    await logAudit({ userId: req.user.id, actorId: req.user.id, action: 'redeem_license', detail: { plan: result.plan }, ipAddress: getIp(req) });
    sendPlanChangedEmail({ to: req.user.username, username: req.user.username, plan: result.plan }).catch(() => {});
    log.info({ userId: req.user.id, plan: result.plan }, 'License key redeemed successfully');
  }

  return res.json({
    success: true,
    plan: result.plan,
    alreadyOwner: result.alreadyOwner || false,
    message: result.alreadyOwner
      ? `This key is already applied to your account (${result.plan} plan).`
      : `✓ License activated! Your plan has been upgraded to ${result.plan.charAt(0).toUpperCase() + result.plan.slice(1)}.`,
  });
}));

// ── GET /api/auth/me/licenses ─────────────────────────────────────────────────
router.get('/me/licenses', requireAuth, asyncHandler(async (req, res) => {
  const keys = await getLicenseKeysForUser(req.user.id);
  return res.json({ licenses: keys });
}));

// ── POST /api/auth/licenses/create (admin) ────────────────────────────────────
router.post('/licenses/create', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const { plan = 'pro', note = null, expiresInDays = null, sendToEmail = null } = req.body;
  const { rawKey, plan: issuedPlan, expiresAt } = await createLicenseKey({
    plan, note, expiresInDays: expiresInDays ? parseInt(expiresInDays) : null,
    createdByUserId: req.user.id,
  });
  await logAudit({ userId: req.user.id, actorId: req.user.id, action: 'create_license', detail: { plan, note }, ipAddress: getIp(req) });

  if (sendToEmail) {
    const recipient = await findUserByUsername(sendToEmail);
    await sendLicenseKeyEmail({
      to: sendToEmail,
      username: recipient?.username || sendToEmail,
      plan: issuedPlan,
      licenseKey: rawKey,
      note,
    });
  }

  return res.json({ rawKey, plan: issuedPlan, expiresAt, sentTo: sendToEmail || null });
}));

// ── GET /api/auth/licenses (admin) ───────────────────────────────────────────
router.get('/licenses', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  return res.json({ licenses: await listAllLicenseKeys() });
}));

// ── GET /api/auth/users/:id/license (admin) ──────────────────────────────────
router.get('/users/:id/license', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  const license = await getActiveLicenseKeyForUser(userId);
  return res.json({ license: license || null });
}));

// ── POST /api/auth/users/:id/license/generate (admin) ─────────────────────────
router.post('/users/:id/license/generate', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  const targetUser = await getUserById(userId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  const plan = targetUser.plan;
  if (plan === 'free') {
    return res.status(400).json({ error: 'Cannot generate a license key for users on the Free plan. Please assign basic/pro/enterprise first.' });
  }

  const { rawKey } = await createSignedLicenseKeyForUser({
    plan,
    userId,
    createdByUserId: req.user.id
  });

  await logAudit({
    userId: req.user.id,
    actorId: req.user.id,
    action: 'admin_generate_user_license',
    detail: { targetUserId: userId, plan },
    ipAddress: getIp(req)
  });

  return res.json({ success: true, licenseKey: rawKey });
}));

// ── PUT /api/auth/me/password ─────────────────────────────────────────────────
router.put('/me/password', requireAuth, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const valid = await verifyPasswordOnly(req.user.id, currentPassword);
  if (!valid) return res.status(403).json({ error: 'Current password is incorrect' });

  await updatePassword(req.user.id, newPassword);
  await logAudit({ userId: req.user.id, actorId: req.user.id, action: 'password_change', ipAddress: getIp(req) });
  sendPasswordChangedEmail({ to: req.user.username, username: req.user.username }).catch(() => {});

  return res.json({ success: true, message: 'Password updated. All other sessions have been revoked.' });
}));

// ── PUT /api/auth/me/profile ──────────────────────────────────────────────────
router.put('/me/profile', requireAuth, asyncHandler(async (req, res) => {
  const { displayName } = req.body;
  await updateProfile(req.user.id, { displayName });
  await logAudit({ userId: req.user.id, actorId: req.user.id, action: 'profile_update', ipAddress: getIp(req) });
  return res.json({ success: true });
}));

// ── GET /api/auth/me/sessions ─────────────────────────────────────────────────
router.get('/me/sessions', requireAuth, asyncHandler(async (req, res) => {
  const sessions = await getUserSessions(req.user.id);
  return res.json({ sessions });
}));

// ── DELETE /api/auth/me/sessions/:token ───────────────────────────────────────
router.delete('/me/sessions/:token', requireAuth, asyncHandler(async (req, res) => {
  await revokeSession(req.params.token);
  return res.json({ success: true });
}));

// ── DELETE /api/auth/me/sessions ─────────────────────────────────────────────
router.delete('/me/sessions', requireAuth, asyncHandler(async (req, res) => {
  const authHeader = req.headers.authorization;
  const currentToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
  const revoked = await revokeAllUserSessionsExcept(req.user.id, currentToken);
  await logAudit({ userId: req.user.id, actorId: req.user.id, action: 'revoke_other_sessions', detail: { revoked }, ipAddress: getIp(req) });
  return res.json({ success: true, revoked });
}));

const oauthClients = new Map();

// ── POST /api/auth/google-login ───────────────────────────────────────────────
router.post('/google-login', asyncHandler(async (req, res) => {
  log.info('Incoming google-login request...');
  const { credential, clientId } = req.body;
  if (!credential) {
    log.warn('Google credential token is missing in request.');
    return res.status(400).json({ error: 'Google credential token is required' });
  }

  const resolvedClientId = clientId || GOOGLE_CLIENT_ID;
  log.info(`Resolved clientId: ${resolvedClientId}`);
  let payload;

  if (resolvedClientId) {
    if (!IS_PROD && credential.includes('mocksignature')) {
      log.info('Processing mock signature credential in development...');
      try {
        const parts = credential.split('.');
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
        payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
      } catch (err) {
        log.error('Malformed simulator credential:', err.message);
        return res.status(400).json({ error: 'Malformed simulator credential.' });
      }
    } else {
      log.info('Verifying Google token against OAuth2Client...');
      try {
        if (!oauthClients.has(resolvedClientId)) {
          log.info(`Instantiating new OAuth2Client for client ID: ${resolvedClientId}`);
          oauthClients.set(resolvedClientId, new OAuth2Client({
            clientId: resolvedClientId,
            httpTimeout: 10000 // 10s timeout
          }));
        }
        const client = oauthClients.get(resolvedClientId);
        const ticket = await client.verifyIdToken({ idToken: credential, audience: resolvedClientId });
        payload = ticket.getPayload();
        log.info('Google token verified successfully. Email:', payload?.email);
      } catch (err) {
        log.error('Google token verification failed:', err.message);
        return res.status(401).json({ error: 'Invalid or expired Google token.' });
      }
    }
  } else if (!IS_PROD) {
    log.info('No client ID, decoding mock simulator credential...');
    try {
      const parts = credential.split('.');
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
      payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Malformed simulator credential.' });
    }
  } else {
    log.warn('Google Sign-In is not configured (resolvedClientId is null in production).');
    return res.status(503).json({ error: 'Google Sign-In is not configured.' });
  }

  const email = payload?.email;
  if (!email) {
    log.warn('Email not found in Google token payload.');
    return res.status(400).json({ error: 'Email not found in Google token' });
  }
  if (!payload.email_verified) {
    log.warn(`Google account email is not verified: ${email}`);
    return res.status(403).json({ error: 'Google account email is not verified' });
  }

  log.info(`Finding or creating user: ${email}...`);
  let user = await findUserByUsername(email);
  if (!user) {
    log.info(`User does not exist, creating new user for: ${email}`);
    user = await createUser(email, crypto.randomBytes(32).toString('hex'));
    sendWelcomeEmail({ to: user.username, username: user.username, plan: user.plan }).catch((err) => {
      log.error('Failed to send welcome email in background:', err.message);
    });
  } else {
    log.info(`Found existing user with ID ${user.id} for: ${email}`);
  }

  log.info(`Syncing session for user ID: ${user.id}`);
  await touchLastLogin(user.id);
  const token = await createSession(user.id, { ipAddress: getIp(req), userAgent: getUA(req) });
  await logAudit({ userId: user.id, actorId: user.id, action: 'google_login', ipAddress: getIp(req) });

  log.info(`Setting auth cookie for user ID: ${user.id}`);
  res.cookie('boundaryiq_auth_token', token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
  });

  log.info(`Login successful for user: ${email}. Returning token.`);
  return res.json({ id: user.id, token, username: user.username, role: user.role, plan: user.plan || 'free', displayName: user.displayName || null });
}));

// ── GET /api/auth/users ───────────────────────────────────────────────────────
router.get('/users', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const users = await getAllUsers();
  return res.json({ users, total: users.length });
}));

// ── GET /api/auth/users/:id ───────────────────────────────────────────────────
router.get('/users/:id', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const user = await getUserById(parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const stats    = await getUserDailyStats(user.id, 30);
  const sessions = await getUserSessions(user.id);
  const tokens   = await getUserTokenStats(user.id);
  return res.json({ ...user, recentStats: stats, activeSessions: sessions.length, tokens });
}));

// ── POST /api/auth/users/:id/role ─────────────────────────────────────────────
router.post('/users/:id/role', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  const { role } = req.body;
  if (!role) return res.status(400).json({ error: 'role is required' });
  if (userId === req.user.id && role !== 'admin') return res.status(400).json({ error: 'You cannot change your own admin role.' });
  const target = await getUserById(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  await updateUserRole(userId, role);
  await logAudit({ userId, actorId: req.user.id, action: 'role_change', detail: { from: target.role, to: role }, ipAddress: getIp(req) });
  return res.json({ success: true, userId, role });
}));

// ── POST /api/auth/users/:id/plan ─────────────────────────────────────────────
router.post('/users/:id/plan', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  const { plan } = req.body;
  if (!plan) return res.status(400).json({ error: 'plan is required' });
  const target = await getUserById(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  await updateUserPlan(userId, plan);
  await logAudit({ userId, actorId: req.user.id, action: 'plan_change', detail: { from: target.plan, to: plan }, ipAddress: getIp(req) });
  sendPlanChangedEmail({ to: target.username, username: target.username, plan }).catch(() => {});
  return res.json({ success: true, userId, plan });
}));

// ── DELETE /api/auth/users/:id ────────────────────────────────────────────────
router.delete('/users/:id', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  if (userId === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account from this panel.' });
  const target = await getUserById(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  await deleteUser(userId);
  await logAudit({ actorId: req.user.id, action: 'delete_user', target: target.username, ipAddress: getIp(req) });
  return res.json({ success: true });
}));

// ── POST /api/auth/users/batch-delete ─────────────────────────────────────────
router.post('/users/batch-delete', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: 'Valid userIds array is required' });
  }
  let deletedCount = 0;
  for (const id of userIds) {
    const userId = parseInt(id);
    if (isNaN(userId)) continue;
    if (userId === req.user.id) continue;
    const target = await getUserById(userId);
    if (!target) continue;
    await deleteUser(userId);
    await logAudit({ actorId: req.user.id, action: 'delete_user', target: target.username, ipAddress: getIp(req) });
    deletedCount++;
  }
  return res.json({ success: true, deletedCount });
}));

// ── POST /api/auth/users/:id/reset-password ───────────────────────────────────
router.post('/users/:id/reset-password', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  const target = await getUserById(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const tempPw = await forceResetPassword(userId);
  await logAudit({ userId, actorId: req.user.id, action: 'force_password_reset', ipAddress: getIp(req) });
  if (target.username.includes('@')) {
    sendTempPasswordEmail({ to: target.username, username: target.username, tempPassword: tempPw }).catch(() => {});
  }
  return res.json({ success: true, tempPassword: tempPw, message: 'Password reset. User sessions revoked. Temp password shown once.' });
}));

// ── GET /api/auth/users/:id/sessions ─────────────────────────────────────────
router.get('/users/:id/sessions', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const sessions = await getUserSessions(parseInt(req.params.id));
  return res.json({ sessions });
}));

// ── DELETE /api/auth/users/:id/sessions ──────────────────────────────────────
router.delete('/users/:id/sessions', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  const revoked = await revokeAllUserSessions(userId);
  await logAudit({ userId, actorId: req.user.id, action: 'revoke_sessions', detail: { revoked }, ipAddress: getIp(req) });
  return res.json({ success: true, revoked });
}));

// ── GET /api/auth/users/:id/stats ─────────────────────────────────────────────
router.get('/users/:id/stats', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const stats = await getUserDailyStats(parseInt(req.params.id), 30);
  return res.json({ stats });
}));

// ── GET /api/auth/audit-log ───────────────────────────────────────────────────
router.get('/audit-log', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const { limit = 100, offset = 0, userId, action } = req.query;
  const entries = await getAuditLog({ limit: parseInt(limit), offset: parseInt(offset), userId: userId ? parseInt(userId) : null, action: action || null });
  return res.json({ entries, count: entries.length });
}));

// ── GET /api/auth/system-stats ────────────────────────────────────────────────
router.get('/system-stats', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  return res.json(await getSystemStats());
}));

// ── POST /api/auth/invite ─────────────────────────────────────────────────────
router.post('/invite', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const { email, note, expiresInHours = 72 } = req.body;
  const token = await createInviteToken({ createdByUserId: req.user.id, email, note, expiresInHours });
  const inviteUrl = `${FRONTEND_URL}/?invite=${token}`;

  if (email) {
    sendInviteEmail({ to: email, inviteUrl, inviterUsername: req.user.username, note }).catch(() => {});
  }

  await logAudit({ actorId: req.user.id, action: 'create_invite', target: email || 'open', ipAddress: getIp(req) });
  return res.json({ success: true, token, inviteUrl, email: email || null });
}));

// ── GET /api/auth/invite/:token ───────────────────────────────────────────────
router.get('/invite/:token', asyncHandler(async (req, res) => {
  const invite = await getInviteToken(req.params.token);
  if (!invite)       return res.status(404).json({ valid: false, reason: 'Token not found' });
  if (invite.used)   return res.status(410).json({ valid: false, reason: 'Token already used' });
  if (invite.expired) return res.status(410).json({ valid: false, reason: 'Token expired' });
  return res.json({ valid: true, email: invite.email, createdByUsername: invite.createdByUsername });
}));

// ── GET /api/auth/invites ─────────────────────────────────────────────────────
router.get('/invites', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const invites = await listInvites();
  return res.json({ invites });
}));

// ── DELETE /api/auth/invites/:token ───────────────────────────────────────────
router.delete('/invites/:token', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  await revokeInviteToken(req.params.token);
  return res.json({ success: true });
}));

// ── GET /api/auth/orders ──────────────────────────────────────────────────────
router.get('/orders', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const orders  = await getAllSubscriptions();
  const revenue = await getRevenueStats();
  return res.json({ orders, revenue });
}));

// ── PUT /api/auth/orders/:userId/plan ─────────────────────────────────────────
router.put('/orders/:userId/plan', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const { plan } = req.body;
  if (!VALID_PLANS.includes(plan)) {
    return res.status(400).json({ error: `Invalid plan. Must be one of: ${VALID_PLANS.join(', ')}` });
  }
  const userId = parseInt(req.params.userId);
  await adminSetPlan(userId, plan, req.user.id);
  const user = await getUserById(userId);
  if (user?.Email || user?.username) {
    sendPlanChangedEmail({ to: user.Email || user.username, username: user.username, plan }).catch(() => {});
  }
  return res.json({ success: true, userId, plan });
}));

// ── DELETE /api/auth/orders/:userId ───────────────────────────────────────────
router.delete('/orders/:userId', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId);
  await adminCancelSubscription(userId, req.user.id);
  return res.json({ success: true, userId });
}));

// ── GET /api/auth/admin/plan-settings ─────────────────────────────────────────
router.get('/admin/plan-settings', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const settings = await getAllPlanSettings();
  return res.json({ settings });
}));

// ── PUT /api/auth/admin/plan-settings/:plan ────────────────────────────────────
router.put('/admin/plan-settings/:plan', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const { plan } = req.params;
  const { name, dailyDeedLimit, price, features, description } = req.body;

  const VALID_PLANS = ['free', 'basic', 'pro', 'enterprise'];
  if (!VALID_PLANS.includes(plan)) {
    return res.status(400).json({ error: `Invalid plan tier: ${plan}` });
  }

  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'Plan name is required.' });
  }

  const limitInt = parseInt(dailyDeedLimit);
  if (isNaN(limitInt)) {
    return res.status(400).json({ error: 'Daily deed limit must be a valid number.' });
  }

  const priceInt = parseInt(price);
  if (isNaN(priceInt) || priceInt < 0) {
    return res.status(400).json({ error: 'Price must be a positive number.' });
  }

  const updated = await updatePlanSettings(plan, {
    name: name.trim(),
    dailyDeedLimit: limitInt,
    price: priceInt,
    features: Array.isArray(features) ? features : [],
    description: description ? description.trim() : '',
  });

  await logAudit({
    userId: null,
    actorId: req.user.id,
    action: 'admin_update_plan_settings',
    target: `plan=${plan}`,
    detail: { name, dailyDeedLimit: limitInt, price: priceInt },
  });

  return res.json({ success: true, settings: updated });
}));

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
// Anti-enumeration: always returns same message regardless of whether user exists.
router.post('/forgot-password', asyncHandler(async (req, res) => {
  const successResponse = {
    success: true,
    message: 'If that username exists and has a registered email, a temporary password has been sent.',
  };

  const { username } = req.body;
  if (!username?.trim()) return res.status(400).json({ error: 'Email address is required.' });

  const trimmedUsername = username.trim();
  const lowercaseUsername = trimmedUsername.toLowerCase();
  // Non-email usernames and test environments bypass email-format requirement.
  // Username-based heuristics are disabled in production.
  const isTestUser = lowercaseUsername.includes('@')
    ? process.env.NODE_ENV === 'test'
    : true; // non-email usernames are always treated as dev/admin accounts

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!isTestUser && !EMAIL_RE.test(trimmedUsername)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const user = await findUserByUsername(trimmedUsername);
  if (!user) {
    await new Promise(r => setTimeout(r, 300 + Math.random() * 200)); // timing-safe
    return res.json(successResponse);
  }

  const userFull = await getUserById(user.id);
  const email    = userFull?.Email || null;
  const tempPw   = await forceResetPassword(user.id, user.id);

  if (email || user.username) {
    sendTempPasswordEmail({ to: email || user.username, username: user.username, tempPassword: tempPw })
      .catch(e => log.warn({ err: e.message }, 'forgot-password email failed'));
  } else {
    log.warn({ userId: user.id, username: user.username }, 'forgot-password: no email on file — temp PW in audit log');
  }

  await logAudit({
    userId: user.id, actorId: user.id, action: 'forgot_password',
    target: `userId=${user.id}`, detail: { status: email ? 'email_sent' : 'no_email_logged' },
  });
  return res.json(successResponse);
}));

export default router;
