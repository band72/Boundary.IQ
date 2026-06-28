import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import billingRouter from '../routes/billing.js';

// Mock the 'stripe' package to control webhook validation behavior
vi.mock('stripe', () => {
  return {
    default: vi.fn().mockImplementation(() => {
      return {
        webhooks: {
          constructEvent: (body, sig, secret) => {
            if (sig === 'valid-signature' && secret === 'valid-secret') {
              return { type: 'checkout.session.completed', id: 'evt_123', data: { object: {} } };
            }
            throw new Error('Invalid signature');
          }
        }
      };
    })
  };
});

describe('Stripe Webhook Security Tests', () => {
  let app;
  let server;
  let baseUrl;
  let originalEnv;

  beforeAll(() => {
    originalEnv = { ...process.env };
    
    app = express();
    app.use('/api/billing', express.raw({ type: 'application/json' }), billingRouter);
    
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://localhost:${port}/api/billing/webhook`;
  });

  afterAll(() => {
    server.close();
    process.env = originalEnv;
  });

  it('rejects webhook requests with 400 when signature is invalid', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
    process.env.STRIPE_WEBHOOK_SECRET = 'valid-secret';

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'stripe-signature': 'invalid-signature',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ test: true }),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Webhook Error');
  });

  it('returns 500 in production when STRIPE_WEBHOOK_SECRET is missing', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
    delete process.env.STRIPE_WEBHOOK_SECRET;
    process.env.NODE_ENV = 'production';

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'stripe-signature': 'valid-signature',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ test: true }),
    });

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe('Webhook secret not configured');
  });

  it('skips verification in development when STRIPE_WEBHOOK_SECRET is missing', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
    delete process.env.STRIPE_WEBHOOK_SECRET;
    process.env.NODE_ENV = 'development';

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'stripe-signature': 'any',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ test: true }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.received).toBe(true);
  });
});
