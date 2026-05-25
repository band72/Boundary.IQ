/**
 * Central API configuration.
 * Uses Vite environment variable with fallback to localhost.
 */
export const API = import.meta.env.VITE_API_URL || 'http://localhost:5050/api';
