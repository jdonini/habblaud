// Fonte de agentes do Antigravity CLI (AgentSource 'antigravity').
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentStatus, SourceInfo } from '../../../shared/types';
import type { AccountsService } from '../../accounts/service';
import { log } from '../../log';
import type { Office } from '../../model/office';
import type { PermissionRegistry } from '../../permissions/registry';
import type { AgentSource } from '../source';
import { FileTail } from '../tail';
import { activeConversationIds, antigravityTranscriptPath, readWorkspacesFromHistory } from './files';
import { parseAntigravityLine } from './transcript';
import { createAntigravityTerminalParser } from './terminal';

interface ActiveTracker {
  conversationId: string;
  agentId: string;
  workspace: string;
  tail?: FileTail;
  status: AgentStatus;
  waitingFor?: string;
  activeSubagents: Set<string>;
  pendingQuestionId?: string;
}

export interface AntigravitySourceOptions {
  accounts: AccountsService;
  office: Office;
  dir: string;
  home?: string;
  pollMs?: number;
  permissions?: () => PermissionRegistry | undefined;
}

export class AntigravitySource implements AgentSource {
  readonly provider = 'antigravity';
  private timer?: NodeJS.Timeout;
  private trackers = new Map<string, ActiveTracker>();
  private readonly pollMs: number;

  constructor(private readonly opts: AntigravitySourceOptions) {
    this.pollMs = opts.pollMs ?? 2_000;
  }

  start(): void {
    log.info(`Fonte de agentes Antigravity: iniciando em ${this.opts.dir}`);
    this.registerAccount();
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const tracker of this.trackers.values()) {
      if (tracker.pendingQuestionId) {
        this.opts.permissions?.()?.cancelSynthetic(tracker.pendingQuestionId, 'shutdown');
      }
    }
  }

  sources(): SourceInfo[] {
    return [
      {
        id: 'antigravity',
        name: 'Antigravity',
        dir: this.opts.dir,
        sessions: this.trackers.size,
      },
    ];
  }

  transcriptPathOf(agentId: string): string | undefined {
    const tracker = this.trackers.get(agentId);
    if (!tracker) return undefined;
    const p = antigravityTranscriptPath(this.opts.dir, tracker.conversationId);
    return existsSync(p) ? p : undefined;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    const tracker = this.trackers.get(agentId);
    return tracker ? createAntigravityTerminalParser(tracker.conversationId) : undefined;
  }

  private registerAccount(): void {
    this.opts.accounts.setProviderAccounts('antigravity', [
      {
        dir: this.opts.dir,
        detected: {
          id: 'antigravity',
          provider: 'antigravity',
          configDir: this.opts.dir,
          short: 'G',
          name: 'Antigravity',
          plan: 'Google AI Pro',
          color: '#a77bf3',
        },
      },
    ]);
  }

  private poll(): void {
    try {
      const activeIds = new Set(activeConversationIds(this.opts.dir));
      const workspaces = readWorkspacesFromHistory(this.opts.dir);

      // 1. Detectar e adicionar novas sessões ativas
      for (const convId of activeIds) {
        const agentId = `antigravity:${convId}`;
        let tracker = this.trackers.get(agentId);

        if (!tracker) {
          const workspace = workspaces.get(convId) || process.cwd();
          const tPath = antigravityTranscriptPath(this.opts.dir, convId);
          let startedAt = Date.now();
          if (existsSync(tPath)) {
            try {
              startedAt = statSync(tPath).birthtimeMs || statSync(tPath).mtimeMs || startedAt;
            } catch {
              // ignore
            }
          }

          tracker = {
            conversationId: convId,
            agentId,
            workspace,
            status: 'working',
            activeSubagents: new Set(),
          };

          if (existsSync(tPath)) {
            tracker.tail = new FileTail(tPath);
            // Começa lendo os últimos 512 KB se for arquivo grande
            tracker.tail.seekTail(512 * 1024);
          }

          this.trackers.set(agentId, tracker);

          this.opts.office.addMain({
            id: agentId,
            provider: 'antigravity',
            account: 'antigravity',
            sessionId: convId,
            cwd: workspace,
            role: 'Antigravity Assistant',
            startedAt,
            status: 'working',
          });
        }

        // Ler novidades da transcrição
        if (tracker.tail) {
          const read = tracker.tail.readLines();
          for (const line of read.lines) {
            const parsed = parseAntigravityLine(line, convId);
            if (parsed) {
              for (const act of parsed.activities) {
                this.opts.office.addActivity(agentId, act);
              }

              // Subagentes visuais
              if (parsed.subagents && parsed.subagents.length > 0) {
                for (const sub of parsed.subagents) {
                  const ok = this.opts.office.addSub({
                    id: sub.id,
                    parentId: agentId,
                    sessionId: tracker.conversationId,
                    role: sub.role,
                    title: sub.title,
                    background: false,
                    startedAt: Date.now(),
                  });
                  if (ok) {
                    tracker.activeSubagents.add(sub.id);
                  }
                }
              }

              if (parsed.subagentsDone && tracker.activeSubagents.size > 0) {
                for (const subId of tracker.activeSubagents) {
                  this.opts.office.completeSub(subId);
                }
                tracker.activeSubagents.clear();
              }

              // Perguntas interativas (ask_question)
              if (parsed.question && this.opts.permissions) {
                const permReg = this.opts.permissions();
                if (permReg) {
                  if (tracker.pendingQuestionId) {
                    permReg.cancelSynthetic(tracker.pendingQuestionId);
                    tracker.pendingQuestionId = undefined;
                  }
                  const qInfo = parsed.question;
                  const firstQ = qInfo.questions[0]?.question || 'Pergunta';
                  const permId = permReg.registerSynthetic({
                    agentId,
                    sessionId: convId,
                    tool: 'ask_question',
                    title: 'Pergunta interativa',
                    text: firstQ,
                    icon: '❓',
                    provider: 'antigravity',
                    questions: qInfo.questions,
                    timeoutMs: 300_000,
                    onDecision: (d) => {
                      log.info(`Antigravity pergunta respondida na interface para ${agentId}: ${JSON.stringify(d)}`);
                      tracker.pendingQuestionId = undefined;
                    },
                  });
                  tracker.pendingQuestionId = permId;
                }
              }

              if (parsed.status && parsed.status !== tracker.status) {
                tracker.status = parsed.status;
                tracker.waitingFor = parsed.waitingFor;
                if (tracker.pendingQuestionId && parsed.status !== 'waiting') {
                  this.opts.permissions?.()?.cancelSynthetic(tracker.pendingQuestionId);
                  tracker.pendingQuestionId = undefined;
                }
                this.opts.office.setStatus(agentId, parsed.status, parsed.waitingFor);
              }
            }
          }
        }
      }

      // 2. Encerrar sessões que não estão mais ativas
      for (const [agentId, tracker] of this.trackers.entries()) {
        if (!activeIds.has(tracker.conversationId)) {
          if (tracker.pendingQuestionId) {
            this.opts.permissions?.()?.cancelSynthetic(tracker.pendingQuestionId, 'gone');
            tracker.pendingQuestionId = undefined;
          }
          for (const subId of tracker.activeSubagents) {
            this.opts.office.completeSub(subId, { notify: false });
          }
          tracker.activeSubagents.clear();
          this.opts.office.closeMain(agentId);
          this.trackers.delete(agentId);
        }
      }
    } catch (err) {
      log.warn(`Erro no polling do Antigravity: ${err}`);
    }
  }
}
