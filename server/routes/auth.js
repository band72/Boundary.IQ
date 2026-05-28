import { Router } from 'express';
import { createUser, verifyUser, createSession, getSession, deleteSession, findUserByUsername } from '../services/diagnosticsDb.js';
import crypto from 'crypto';

const router = Router();

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
router.post('/google-login', (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Google credential token is required' });
    }

    const parts = credential.split('.');
    if (parts.length !== 3) {
      return res.status(400).json({ error: 'Invalid Google credential token shape' });
    }

    const payloadJson = Buffer.from(parts[1], 'base64').toString('utf-8');
    const payload = JSON.parse(payloadJson);

    const email = payload.email;
    if (!email) {
      return res.status(400).json({ error: 'Email not found in Google credential token' });
    }

    // Try finding the user
    let user = findUserByUsername(email);
    
    if (!user) {
      // Create a new user automatically with a randomized password hash (so they can only sign in via Google)
      const randomPassword = crypto.randomBytes(32).toString('hex');
      user = createUser(email, randomPassword, 'user');
    }

    // Create session
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
