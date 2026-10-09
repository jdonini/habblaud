#!/usr/bin/env node
// Sincroniza métricas do ai-usagebar com o Habblaud (~/.habblaud/usage/)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.HOME || homedir();
const usageDir = process.env.HABBLAUD_USAGE_DIR || join(home, '.habblaud', 'usage');

try {
  const stdout = execFileSync('ai-usagebar', ['usage', '--json'], { encoding: 'utf-8' });
  const data = JSON.parse(stdout);

  if (!Array.isArray(data.entries)) {
    console.error('ai-usagebar: saída inválida (sem entries)');
    process.exit(1);
  }

  mkdirSync(usageDir, { recursive: true });

  for (const entry of data.entries) {
    const id = entry.id || entry.brand;
    const fetchedAt = entry.fetched_at ? new Date(entry.fetched_at).getTime() : Date.now();

    let fiveHourMetric;
    let sevenDayMetric;

    if (id === 'antigravity') {
      fiveHourMetric = entry.metrics.find((m) => m.window_secs === 18000 && m.label?.includes('Gemini')) ||
                       entry.metrics.find((m) => m.window_secs === 18000);
      sevenDayMetric = entry.metrics.find((m) => m.window_secs === 604800 && m.label?.includes('Gemini')) ||
                       entry.metrics.find((m) => m.window_secs === 604800);
    } else {
      fiveHourMetric = entry.metrics.find((m) => m.window_secs === 18000);
      sevenDayMetric = entry.metrics.find((m) => m.window_secs === 604800);
    }

    let accountId = '';
    let configDir = '';
    let fileName = '';

    if (id === 'anthropic') {
      accountId = '.claude';
      configDir = join(home, '.claude');
      fileName = '.claude.json';
    } else if (id === 'openai') {
      accountId = '.codex';
      configDir = join(home, '.codex');
      fileName = '.codex.json';
    } else if (id === 'antigravity') {
      accountId = 'antigravity';
      configDir = join(home, '.gemini', 'antigravity-cli');
      fileName = 'antigravity.json';
    } else {
      continue;
    }

    const payload = {
      accountId,
      configDir,
      fetchedAt,
      source: 'ai-usagebar',
    };

    if (fiveHourMetric && typeof fiveHourMetric.percent === 'number') {
      payload.five_hour = {
        utilization: fiveHourMetric.percent,
        resets_at: fiveHourMetric.reset_at ? Math.floor(new Date(fiveHourMetric.reset_at).getTime() / 1000) : 0,
      };
    }

    if (sevenDayMetric && typeof sevenDayMetric.percent === 'number') {
      payload.seven_day = {
        utilization: sevenDayMetric.percent,
        resets_at: sevenDayMetric.reset_at ? Math.floor(new Date(sevenDayMetric.reset_at).getTime() / 1000) : 0,
      };
    }

    const targetPath = join(usageDir, fileName);
    writeFileSync(targetPath, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`[ai-usagebar] Atualizado ${fileName}: 5h=${payload.five_hour?.utilization ?? '-'}% 7d=${payload.seven_day?.utilization ?? '-'}%`);
  }
} catch (err) {
  console.error('[ai-usagebar] Erro ao sincronizar:', err.message);
  process.exit(1);
}
