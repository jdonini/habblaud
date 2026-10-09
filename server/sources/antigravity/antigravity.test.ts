import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverAntigravityDir, antigravityTranscriptPath, readWorkspacesFromHistory } from './files';
import { parseAntigravityLine } from './transcript';
import { AntigravitySource } from './source';
import { AccountsService } from '../../accounts/service';
import { Office } from '../../model/office';
import { NameStore } from '../../model/names';

describe('Antigravity files discovery', () => {
  it('detecta diretório via env ANTIGRAVITY_DIR ou ANTIGRAVITY_HOME', () => {
    const testDir = join(tmpdir(), 'antigravity-test-env');
    mkdirSync(testDir, { recursive: true });
    try {
      const found = discoverAntigravityDir({ ANTIGRAVITY_DIR: testDir }, '/other');
      expect(found).toBe(testDir);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('lê histórico de workspaces de history.jsonl', () => {
    const testDir = join(tmpdir(), 'antigravity-history-test');
    mkdirSync(testDir, { recursive: true });
    try {
      const historyFile = join(testDir, 'history.jsonl');
      const lines = [
        JSON.stringify({ conversationId: 'conv-1', workspace: '/home/user/project1' }),
        JSON.stringify({ session_id: 'conv-2', working_directory: '/home/user/project2' }),
      ].join('\n');
      writeFileSync(historyFile, lines, 'utf8');

      const map = readWorkspacesFromHistory(testDir);
      expect(map.get('conv-1')).toBe('/home/user/project1');
      expect(map.get('conv-2')).toBe('/home/user/project2');
      expect(map.get('unknown')).toBeUndefined();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('calcula caminho correto do transcript', () => {
    const path = antigravityTranscriptPath('/var/lib/agy', 'session-abc');
    expect(path).toBe('/var/lib/agy/brain/session-abc/.system_generated/logs/transcript.jsonl');
  });
});

describe('Antigravity transcript parsing', () => {
  it('interpreta USER_INPUT e converte para atividade e status working', () => {
    const line = JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: 'Por favor, corrija o bug no servidor',
    });
    const parsed = parseAntigravityLine(line, 'conv-1');
    expect(parsed).toBeDefined();
    expect(parsed!.status).toBe('working');
    expect(parsed!.activities.length).toBe(1);
    expect(parsed!.activities[0].text).toBe('Por favor, corrija o bug no servidor');
    expect(parsed!.activities[0].kind).toBe('prompt');
  });

  it('interpreta ferramentas no PLANNER_RESPONSE (run_command, replace_file_content)', () => {
    const line = JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'run_command',
          args: {
            CommandLine: 'npm test',
          },
        },
        {
          name: 'replace_file_content',
          args: {
            TargetFile: '/workspace/src/app.ts',
          },
        },
      ],
    });
    const parsed = parseAntigravityLine(line, 'conv-1');
    expect(parsed).toBeDefined();
    expect(parsed!.status).toBe('working');
    expect(parsed!.activities.length).toBe(2);
    expect(parsed!.activities[0].text).toBe('$ npm test');
    expect(parsed!.activities[0].kind).toBe('test');
    expect(parsed!.activities[1].text).toBe('Editando app.ts');
    expect(parsed!.activities[1].kind).toBe('edit');
  });

  it('detecta ask_question e muda status para waiting', () => {
    const line = JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'ask_question',
          args: {
            questions: [{ question: 'Deseja continuar com o deploy?' }],
          },
        },
      ],
    });
    const parsed = parseAntigravityLine(line, 'conv-1');
    expect(parsed).toBeDefined();
    expect(parsed!.status).toBe('waiting');
    expect(parsed!.waitingFor).toBe('Deseja continuar com o deploy?');
    expect(parsed!.activities.length).toBe(1);
    expect(parsed!.activities[0].kind).toBe('ask');
  });
});

describe('AntigravitySource', () => {
  it('registra conta e fontes corretamente', () => {
    const testDir = join(tmpdir(), 'antigravity-source-test');
    mkdirSync(testDir, { recursive: true });
    try {
      const names = new NameStore();
      const office = new Office(names);
      const accounts = new AccountsService({
        dirs: [],
        home: testDir,
        env: {},
        onChange: () => {},
        usageDir: testDir,
      });
      const source = new AntigravitySource({ accounts, office, dir: testDir });

      source.start();
      const sources = source.sources();
      expect(sources.length).toBe(1);
      expect(sources[0].id).toBe('antigravity');
      expect(sources[0].name).toBe('Antigravity');

      const acc = accounts.find('antigravity');
      expect(acc).toBeDefined();
      expect(acc?.detected.provider).toBe('antigravity');

      source.stop();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
