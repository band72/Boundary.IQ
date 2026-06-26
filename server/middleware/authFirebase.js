import admin from 'firebase-admin';
import { getSession } from '../services/diagnosticsDb.js';

let adminInitialized = false;
try {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
  adminInitialized = true;
} catch (err) {
  // Gracefully warn and allow fallback for development/testing
  console.warn('Firebase Admin SDK could not be initialized with default credentials. Fallback to local session validation in non-production environments.');
}

export default async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  const idToken = authHeader.split(' ')[1];

  if (adminInitialized) {
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      req.user = decoded; // attach user info to request
      return next();
    } catch (e) {
      if (process.env.NODE_ENV === 'production') {
        console.error('Firebase Auth error', e);
        return res.status(401).json({ error: 'Invalid token' });
      }
    }
  }

  // Fallback: check local session database in development/testing
  if (process.env.NODE_ENV !== 'production') {
    const session = getSession(idToken);
    if (session) {
      req.user = { uid: session.userId, email: session.username };
      return next();
    }
  }

  return res.status(401).json({ error: 'Invalid token' });
};
