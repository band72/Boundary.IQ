import { Router } from 'express';
import { createUser, verifyUser, createSession, getSession, deleteSession, findUserByUsername } from '../services/diagnosticsDb.js';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';

const router = Router();

// Lazily-constructed OAuth2Client — re-used across requests
let _googleClient = null;
function getGoogleClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return null;
  if (!_googleClient) {
    _googleClient = new OAuth2Client(clientId);
  }
  return _googleClient;
}

// POST /api/auth/register
router.post('/register', (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters long' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const user = createUser(trimmedUsername, password);
    const token = createSession(user.id);

    return res.status(201).json({
      token,
      username: user.username,
      role: user.role
    });
  } catch (err) {
    console.error('Registration error:', err.message);
    return res.status(400).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = verifyUser(username.trim(), password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = createSession(user.id);

    return res.json({
      token,
      username: user.username,
      role: user.role
    });
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

    if (token) {
      deleteSession(token);
    }

    return res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;

    if (!token) {
      return res.status(401).json({ error: 'Authorization token not found' });
    }

    const sessionUser = getSession(token);
    if (!sessionUser) {
      return res.status(401).json({ error: 'Session has expired or is invalid' });
    }

    return res.json({
      id: sessionUser.userId,
      username: sessionUser.username,
      role: sessionUser.role
    });
  } catch (err) {
    console.error('Verify session error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/google-login
router.post('/google-login', async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Google credential token is required' });
    }

    const googleClient = getGoogleClient();

    let payload;

    if (googleClient) {
      // ── Live mode: cryptographically verify the token against Google's public keys ──
      try {
        const ticket = await googleClient.verifyIdToken({
          idToken: credential,
          audience: process.env.GOOGLE_CLIENT_ID,
        });
        payload = ticket.getPayload();
      } catch (verifyErr) {
        console.warn('Google token verification failed:', verifyErr.message);
        return res.status(401).json({ error: 'Invalid or expired Google token. Please sign in again.' });
      }
    } else if (process.env.NODE_ENV === 'development') {
      // ── Dev-only simulator: decode without verification — NEVER allowed in production ──
      try {
        const parts = credential.split('.');
        if (parts.length < 2) throw new Error('Malformed JWT');
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded  = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
        payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
        console.log('[Dev Simulator] Google sign-in — decoded payload for:', payload.email);
      } catch (decodeErr) {
        return res.status(400).json({ error: 'Malformed simulator credential token.' });
      }
    } else {
      // ── Production without GOOGLE_CLIENT_ID configured ──
      console.error('[Auth] Google login attempted but GOOGLE_CLIENT_ID is not configured.');
      return res.status(503).json({ error: 'Google Sign-In is not configured on this server. Contact your administrator.' });
    }

    const email = payload?.email;
    if (!email) {
      return res.status(400).json({ error: 'Email not found in Google token' });
    }

    if (!payload.email_verified) {
      return res.status(403).json({ error: 'Google account email is not verified' });
    }

    // Find or create the user
    let user = findUserByUsername(email);
    if (!user) {
      const randomPassword = crypto.randomBytes(32).toString('hex');
      user = createUser(email, randomPassword, 'user');
    }

    const token = createSession(user.id);

    return res.json({
      token,
      username: user.username,
      role: user.role
    });
  } catch (err) {
    console.error('Google login error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

export default router;

