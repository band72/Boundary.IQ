/**
 * logger.js — Structured logger built on pino (already a dependency).
 *
 * Dev mode:  pretty-printed, colorized output via pino-pretty
 * Prod mode: compact JSON (structured, ingested by log aggregators)
 *
 * Usage:
 *   import logger from './logger.js';
 *   logger.info('Server started');
 *   logger.error({ err }, 'Deed processing failed');
 *   const childLog = logger.child({ requestId: 'abc' });
 */

import pino from 'pino';
import { IS_PROD } from './config.js';

const transport = IS_PROD
  ? undefined
  : {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      },
    };

const logger = pino(
  {
    level: process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug'),
    // Redact sensitive fields from log output
    redact: {
      paths: [
        'req.headers.authorization',
        'body.password',
        'body.newPassword',
        'body.currentPassword',
        'body.credential',
      ],
      remove: true,
    },
  },
  transport ? pino.transport(transport) : undefined,
);

export default logger;

/**
 * Create a named child logger with a `service` field.
 * Usage:
 *   const log = createChildLogger('geminiVision');
 *   log.info({ model, bufferKb }, 'AI extract started');
 */
export function createChildLogger(name) {
  return logger.child({ service: name });
}
