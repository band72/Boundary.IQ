import { describe, it, expect, vi, beforeEach } from 'vitest';

// We mock the config module to return a PostgreSQL DATABASE_URL
vi.mock('../config.js', () => ({
  DATABASE_URL: 'postgres://postgres:password@localhost:5432/boundaryiq',
  IS_PROD: false,
  PORT: 3000
}));

// Mock the 'pg' module
const mockQuery = vi.fn();
vi.mock('pg', () => {
  return {
    default: {
      Pool: vi.fn().mockImplementation(function() {
        return {
          query: mockQuery.mockImplementation((sql, params) => {
            if (sql.includes('NOW()')) {
              return Promise.resolve({ rows: [{ now: '2026-07-02 12:00:00' }], rowCount: 1 });
            }
            if (sql.includes('COUNT(*)')) {
              return Promise.resolve({ rows: [{ c: 0 }], rowCount: 1 });
            }
            if (sql.includes('SELECT Name FROM _Migrations')) {
              return Promise.resolve({ rows: [], rowCount: 0 });
            }
            if (sql.includes('SELECT * FROM Users WHERE Username = $1')) {
              return Promise.resolve({ rows: [{ id: 1, username: 'testuser' }], rowCount: 1 });
            }
            if (sql.includes('UPDATE Users')) {
              return Promise.resolve({ rows: [], rowCount: 5 });
            }
            return Promise.resolve({ rows: [], rowCount: 0 });
          }),
          connect: vi.fn().mockImplementation(() => Promise.resolve({
            query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            release: vi.fn()
          })),
          on: vi.fn(),
          end: vi.fn()
        };
      })
    }
  };
});

// Import init and query from core.js
import { init, query, getIsPostgres } from '../services/db/core.js';

describe('PostgreSQL Adapter Integration Tests', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-initialize core with isPostgres forced to true
    await init();
  });

  it('should correctly identify Postgres mode when DATABASE_URL is set', () => {
    expect(getIsPostgres()).toBe(true);
  });

  it('should translate SQLite "?" placeholders to Postgres "$1, $2, ..."', async () => {
    const res = await query(
      'SELECT * FROM Users WHERE Username = ? AND Role = ?',
      ['testuser', 'admin']
    );

    // Verify the query call to the Postgres pool used translated syntax
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT * FROM Users WHERE Username = $1 AND Role = $2',
      ['testuser', 'admin']
    );

    // Verify that lowercase row fields were normalized/duplicated
    expect(res.rows[0].Id).toBe(1);
    expect(res.rows[0].id).toBe(1);
    expect(res.rows[0].Username).toBe('testuser');
    expect(res.rows[0].username).toBe('testuser');
  });

  it('should handle updates and return rowCount as changes', async () => {
    const res = await query(
      'UPDATE Users SET Role = ? WHERE Plan = ?',
      ['pro', 'free']
    );

    expect(mockQuery).toHaveBeenCalledWith(
      'UPDATE Users SET Role = $1 WHERE Plan = $2',
      ['pro', 'free']
    );
    expect(res.changes).toBe(5);
  });
});
