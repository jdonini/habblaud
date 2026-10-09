// Integração automática com o ai-usagebar: sincroniza as cotas de Claude, Codex e Antigravity
// em <usageDir>/<conta>.json para leitura do StatuslineUsageReader sem alterar hooks ou configurações.
import { execFile } from 'node:child_process';
import { accessSync, constants, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { log } from '../log';

export interface UsagebarMetric {
  label?: string;
  percent?: number;
  reset_at?: string;
  window_secs?: number;
}

export interface UsagebarEntry {
  id?: string;
  brand?: string;
  fetched_at?: string;
  metrics?: UsagebarMetric[];
}

export interface UsagebarOutput {
  entries?: UsagebarEntry[];
}

function canExecute(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Localiza o binário ai-usagebar via variável ou PATH. */
export function findUsagebarBin(env: NodeJS.ProcessEnv = process.env, isExecutable: (p: string) => boolean = canExecute): string | undefined {
  const explicit = env.HABBLAUD_USAGEBAR_BIN?.trim();
  if (explicit) return isExecutable(explicit) ? explicit : undefined;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, 'ai-usagebar');
    if (isExecutable(p)) return p;
  }
  return undefined;
}

export function parseAiUsagebarJson(raw: string, home: string): Record<string, unknown>[] {
  let parsed: UsagebarOutput;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.entries)) return [];

  const results: Record<string, unknown>[] = [];

  for (const entry of parsed.entries) {
    if (!entry || !Array.isArray(entry.metrics)) continue;
    const id = entry.id || entry.brand;
    const fetchedAt = entry.fetched_at ? new Date(entry.fetched_at).getTime() : Date.now();

    // Encontra a métrica de 5 horas (18000s) e 7 dias (604800s)
    let fiveHourMetric: UsagebarMetric | undefined;
    let sevenDayMetric: UsagebarMetric | undefined;

    if (id === 'antigravity') {
      // Para o Antigravity, pega preferencialmente o modelo ativo (Gemini)
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

    const payload: Record<string, unknown> = {
      accountId,
      configDir,
      fetchedAt,
      source: 'ai-usagebar',
    };

    if (fiveHourMetric && typeof fiveHourMetric.percent === 'number') {
      const resetsAtSec = fiveHourMetric.reset_at ? Math.floor(new Date(fiveHourMetric.reset_at).getTime() / 1000) : 0;
      payload.five_hour = {
        utilization: fiveHourMetric.percent,
        resets_at: resetsAtSec,
      };
    }

    if (sevenDayMetric && typeof sevenDayMetric.percent === 'number') {
      const resetsAtSec = sevenDayMetric.reset_at ? Math.floor(new Date(sevenDayMetric.reset_at).getTime() / 1000) : 0;
      payload.seven_day = {
        utilization: sevenDayMetric.percent,
        resets_at: resetsAtSec,
      };
    }

    results.push({ fileName, payload });
  }

  return results;
}

export class UsagebarService {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly bin: string,
    private readonly usageDir: string,
    private readonly home: string,
    private readonly intervalMs: number = 60_000,
  ) {}

  start(): void {
    log.info(`ai-usagebar sync: monitorando cotas via ${this.bin}`);
    this.sync();
    this.timer = setInterval(() => this.sync(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  sync(): Promise<void> {
    return new Promise((resolve) => {
      execFile(this.bin, ['usage', '--json'], { timeout: 10_000 }, (err, stdout) => {
        if (err || !stdout) {
          log.warn(`ai-usagebar sync falhou: ${err?.message || 'saída vazia'}`);
          resolve();
          return;
        }

        try {
          const items = parseAiUsagebarJson(stdout, this.home);
          mkdirSync(this.usageDir, { recursive: true });

          for (const item of items) {
            const fileName = item.fileName as string;
            const payload = item.payload;
            const targetPath = join(this.usageDir, fileName);
            writeFileSync(targetPath, JSON.stringify(payload, null, 2), 'utf-8');
          }
        } catch (syncErr) {
          log.warn(`ai-usagebar escrita de uso falhou: ${syncErr}`);
        }
        resolve();
      });
    });
  }
}
