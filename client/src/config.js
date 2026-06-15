/**
 * Central API configuration.
 * In development: Vite proxies /api → http://localhost:5050/api (no CORS)
 * In production: set VITE_API_URL to your deployed API base URL
 */
export const API = import.meta.env.VITE_API_URL || '/api';
