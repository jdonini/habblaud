// Arquivos e detecção do Antigravity CLI (~/.gemini/antigravity-cli).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AntigravitySessionMeta {
  conversationId: string;
  workspace: string;
  title?: string;
  mtimeMs: number;
}

/** Localiza o diretório do Antigravity CLI. */
export function discoverAntigravityDir(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string | undefined {
  const envDir = env.ANTIGRAVITY_HOME || env.ANTIGRAVITY_DIR;
  if (envDir && existsSync(envDir)) {
    return envDir;
  }
  const defaultDir = join(home, '.gemini', 'antigravity-cli');
  if (existsSync(defaultDir) && (existsSync(join(defaultDir, 'brain')) || existsSync(join(defaultDir, 'history.jsonl')))) {
    return defaultDir;
  }
  return undefined;
}

/** Verifica se um lock file do Linux está atualmente travado por algum processo vivo. */
export function isLockHeld(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  try {
    const st = statSync(lockPath);
    const inode = st.ino;
    // No Linux, /proc/locks lista os locks ativos mantidos pelo kernel
    if (existsSync('/proc/locks')) {
      const locksContent = readFileSync('/proc/locks', 'utf-8');
      const inodePattern = new RegExp(`:${inode}\\s`);
      for (const line of locksContent.split('\n')) {
        if (inodePattern.test(line)) {
          return true;
        }
      }
      return false;
    }
  } catch {
    // se falhar ler /proc/locks, cai para o fallback por mtime
  }
  return false;
}

/**
 * Retorna os IDs das conversas com sessões ativas (presença travada ou modificação recente).
 */
export function activeConversationIds(cliDir: string, now: number = Date.now(), maxIdleMs: number = 30 * 60_000): string[] {
  const presenceDir = join(cliDir, 'presence');
  const active: string[] = [];

  if (existsSync(presenceDir)) {
    try {
      const files = readdirSync(presenceDir);
      for (const file of files) {
        if (!file.endsWith('.lock')) continue;
        const convId = file.replace(/\.lock$/, '');
        const lockPath = join(presenceDir, file);
        if (isLockHeld(lockPath)) {
          active.push(convId);
        }
      }
    } catch {
      // ignore
    }
  }

  // Fallback se /proc/locks não achou nada (ou outro OS): checar arquivos de transcrição modificados recentemente
  if (active.length === 0) {
    const brainDir = join(cliDir, 'brain');
    if (existsSync(brainDir)) {
      try {
        const dirs = readdirSync(brainDir);
        for (const dir of dirs) {
          const tPath = join(brainDir, dir, '.system_generated', 'logs', 'transcript.jsonl');
          if (existsSync(tPath)) {
            const st = statSync(tPath);
            if (now - st.mtimeMs < maxIdleMs) {
              active.push(dir);
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }

  return active;
}

/**
 * Lê o histórico de conversas em history.jsonl para mapear conversationId -> workspace.
 */
export function readWorkspacesFromHistory(cliDir: string): Map<string, string> {
  const map = new Map<string, string>();
  const historyPath = join(cliDir, 'history.jsonl');
  if (!existsSync(historyPath)) return map;

  try {
    const lines = readFileSync(historyPath, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        const convId = data.conversationId || data.session_id;
        const ws = data.workspace || data.working_directory;
        if (convId && ws) {
          map.set(convId, ws);
        }
      } catch {
        // ignore malformed line
      }
    }
  } catch {
    // ignore
  }

  return map;
}

/** Caminho do transcript.jsonl de uma conversa do Antigravity. */
export function antigravityTranscriptPath(cliDir: string, conversationId: string): string {
  return join(cliDir, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
}
