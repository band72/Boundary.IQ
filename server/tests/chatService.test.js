import { describe, it, expect, vi, beforeEach } from 'vitest';
import { aiChat } from '../services/chatService.js';

describe('AI Chat Service & Guardrails', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should properly structure conversation payloads and enforce guardrails', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          candidates: [{
            content: {
              parts: [{ text: 'I am BoundaryQC AI and can only assist with surveying or land deeds.' }]
            }
          }]
        })
      })
    );

    const message = 'Can you calculate a COGO traverse?';
    const history = [
      { role: 'user', content: 'Hello' },
      { role: 'ai', content: 'Welcome, how can I help?' }
    ];

    const response = await aiChat(message, history);

    expect(response).toBe('I am BoundaryQC AI and can only assist with surveying or land deeds.');
    expect(fetchSpy).toHaveBeenCalled();

    // Verify request contents
    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);

    // Verify system context guardrails are present at the start
    expect(body.contents[0].role).toBe('user');
    expect(body.contents[0].parts[0].text).toContain('You are BoundaryQC AI, an expert land surveyor assistant.');
    expect(body.contents[0].parts[0].text).toContain('STRICT GUARDRAILS');

    // Verify history roles are correctly mapped (ai -> model)
    expect(body.contents[2].role).toBe('user');
    expect(body.contents[2].parts[0].text).toBe('Hello');
    expect(body.contents[3].role).toBe('model');
    expect(body.contents[3].parts[0].text).toBe('Welcome, how can I help?');

    // Verify current message is appended at the end
    const lastItem = body.contents[body.contents.length - 1];
    expect(lastItem.role).toBe('user');
    expect(lastItem.parts[0].text).toBe('Can you calculate a COGO traverse?');
  });
});
