import http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const OLLAMA_BASE = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

let cachedWslIp = null;
let wslIpResolved = false;

async function getWslIp() {
  if (wslIpResolved) return cachedWslIp;
  if (process.platform !== 'win32') {
    wslIpResolved = true;
    return null;
  }
  try {
    const { stdout } = await execAsync('wsl hostname -I');
    if (stdout) {
      const ip = stdout.trim().split(/\s+/)[0];
      if (ip && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
        cachedWslIp = ip;
        console.log(`[WSL IP Resolver] Dynamically resolved WSL 2 IP: ${cachedWslIp}`);
      }
    }
  } catch (err) {
    console.warn(`[WSL IP Resolver] Failed to resolve WSL 2 IP, falling back to 127.0.0.1:`, err.message);
  }
  wslIpResolved = true;
  return cachedWslIp;
}

/**
 * Drop-in fetch replacement using native Node.js 'http' module
 * to prevent undici socket reuse (ECONNRESET) errors when calling
 * services across the Windows/WSL 2 host bridge.
 * 
 * @param {string} urlOrPath - Target URL or path relative to OLLAMA_BASE
 * @param {object} options - Request options (method, body, headers, signal, dispatcher)
 * @returns {Promise<object>} Fetch-like response object
 */
export async function httpFetch(urlOrPath, options = {}) {
  let urlStr = urlOrPath.startsWith('http') ? urlOrPath : `${OLLAMA_BASE}${urlOrPath}`;
  
  if (process.env.OLLAMA_RUNS_ON_WSL === 'true') {
    const wslIp = await getWslIp();
    if (wslIp) {
      urlStr = urlStr.replace('://127.0.0.1', `://${wslIp}`).replace('://localhost', `://${wslIp}`);
    }
  }

  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    
    const isPost = options.method === 'POST';
    const payload = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : null;
    
    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'Connection': 'close', // Force connection to close after response, preventing socket reuse issues
        ...(options.headers || {})
      }
    };
    
    if (isPost && payload) {
      reqOptions.headers['Content-Type'] = reqOptions.headers['Content-Type'] || 'application/json';
      reqOptions.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    
    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        // Clean up error listener on request to prevent late socket resets from crashing process
        req.removeAllListeners('error');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => data,
          json: async () => JSON.parse(data),
        });
      });
    });
    
    req.on('error', (err) => {
      reject(err);
    });
    
    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy();
        reject(options.signal.reason || new Error('Aborted'));
      } else {
        const onAbort = () => {
          req.destroy();
          reject(options.signal.reason || new Error('Aborted'));
        };
        options.signal.addEventListener('abort', onAbort);
        // Make sure we resolve the promise even if aborted to avoid hangs,
        // though standard AbortSignal handling rejects standard promises.
      }
    }
    
    if (isPost && payload) {
      req.write(payload);
    }
    req.end();
  });
}
