import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies testnet defaults', () => {
    const c = loadConfig({});
    expect(c.networkPassphrase).toContain('Test SDF Network');
    expect(c.anchorTtlSeconds).toBe(180);
    expect(c.baseFee).toBe('100');
    expect(c.dbPath).toBe(':memory:');
  });

  it('rejects a non-numeric / non-positive TTL', () => {
    expect(() => loadConfig({ ANCHOR_TTL_SECONDS: 'soon' })).toThrow(/ANCHOR_TTL_SECONDS/);
    expect(() => loadConfig({ ANCHOR_TTL_SECONDS: '0' })).toThrow(/ANCHOR_TTL_SECONDS/);
    expect(() => loadConfig({ ANCHOR_TTL_SECONDS: '-5' })).toThrow(/ANCHOR_TTL_SECONDS/);
  });

  it('rejects a non-integer / non-positive base fee', () => {
    expect(() => loadConfig({ BASE_FEE: 'free' })).toThrow(/BASE_FEE/);
    expect(() => loadConfig({ BASE_FEE: '0' })).toThrow(/BASE_FEE/);
    expect(() => loadConfig({ BASE_FEE: '1.5' })).toThrow(/BASE_FEE/);
  });

  it('honours overrides', () => {
    const c = loadConfig({ ANCHOR_TTL_SECONDS: '60', BASE_FEE: '200', DB_PATH: 'data/x.db' });
    expect(c.anchorTtlSeconds).toBe(60);
    expect(c.baseFee).toBe('200');
    expect(c.dbPath).toBe('data/x.db');
  });
});
