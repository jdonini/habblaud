import { describe, expect, it } from 'vitest';
import { parseAiUsagebarJson, findUsagebarBin } from './usagebar';

describe('ai-usagebar parsing', () => {
  it('converte JSON do ai-usagebar em registros para Habblaud', () => {
    const raw = JSON.stringify({
      entries: [
        {
          id: 'anthropic',
          brand: 'anthropic',
          fetched_at: '2026-10-09T16:23:50.000Z',
          metrics: [
            { label: 'Session (5h)', percent: 14, reset_at: '2026-10-09T20:00:00.000Z', window_secs: 18000 },
            { label: 'Weekly (7d)', percent: 90, reset_at: '2026-10-10T16:00:00.000Z', window_secs: 604800 },
          ],
        },
        {
          id: 'openai',
          brand: 'openai',
          fetched_at: '2026-10-09T16:23:50.000Z',
          metrics: [
            { label: 'Codex 5h', percent: 22, reset_at: '2026-10-09T21:00:00.000Z', window_secs: 18000 },
            { label: 'Codex weekly', percent: 43, reset_at: '2026-10-14T11:00:00.000Z', window_secs: 604800 },
          ],
        },
        {
          id: 'antigravity',
          brand: 'antigravity',
          fetched_at: '2026-10-09T16:23:50.000Z',
          metrics: [
            { label: 'Gemini', percent: 11, reset_at: '2026-10-09T21:00:00.000Z', window_secs: 18000 },
            { label: 'Gemini', percent: 7, reset_at: '2026-10-12T12:00:00.000Z', window_secs: 604800 },
          ],
        },
      ],
    });

    const parsed = parseAiUsagebarJson(raw, '/home/user');
    expect(parsed.length).toBe(3);

    const claude = parsed.find((p) => p.fileName === '.claude.json');
    expect(claude).toBeDefined();
    expect((claude!.payload as any).accountId).toBe('.claude');
    expect((claude!.payload as any).five_hour.utilization).toBe(14);
    expect((claude!.payload as any).seven_day.utilization).toBe(90);

    const codex = parsed.find((p) => p.fileName === '.codex.json');
    expect(codex).toBeDefined();
    expect((codex!.payload as any).accountId).toBe('.codex');
    expect((codex!.payload as any).five_hour.utilization).toBe(22);
    expect((codex!.payload as any).seven_day.utilization).toBe(43);

    const agy = parsed.find((p) => p.fileName === 'antigravity.json');
    expect(agy).toBeDefined();
    expect((agy!.payload as any).accountId).toBe('antigravity');
    expect((agy!.payload as any).five_hour.utilization).toBe(11);
    expect((agy!.payload as any).seven_day.utilization).toBe(7);
  });

  it('localiza binário via env HABBLAUD_USAGEBAR_BIN', () => {
    const bin = findUsagebarBin({ HABBLAUD_USAGEBAR_BIN: '/opt/bin/ai-usagebar' }, () => true);
    expect(bin).toBe('/opt/bin/ai-usagebar');
  });
});
