// Parser incremental do transcript.jsonl do Antigravity CLI.
import type { Activity, AgentStatus, TaskItem } from '../../../shared/types';
import { basename, truncate } from '../../../shared/activity';

export interface AntigravityStep {
  step_index: number;
  source: string;
  type: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: Array<{
    name: string;
    args?: Record<string, unknown>;
  }>;
}

export interface ParsedStepResult {
  activities: Activity[];
  status?: AgentStatus;
  waitingFor?: string;
  title?: string;
}

function cleanStr(v: unknown): string {
  if (typeof v === 'string') {
    // se vier serializado com aspas extras (ex: "\"https://habblaud.com/\"")
    let s = v.trim();
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
      try {
        s = JSON.parse(s);
      } catch {
        s = s.slice(1, -1);
      }
    }
    return s;
  }
  return '';
}

export function parseAntigravityLine(rawLine: string, sessionId: string): ParsedStepResult | undefined {
  if (!rawLine.trim()) return undefined;
  let step: AntigravityStep;
  try {
    step = JSON.parse(rawLine);
  } catch {
    return undefined;
  }

  const at = step.created_at ? new Date(step.created_at).getTime() : Date.now();
  const activities: Activity[] = [];
  let status: AgentStatus | undefined;
  let waitingFor: string | undefined;

  // 1. Mensagem do usuário
  if (step.type === 'USER_INPUT' && step.content) {
    const text = cleanStr(step.content).replace(/<USER_REQUEST>|<\/USER_REQUEST>|<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '').trim();
    if (text) {
      activities.push({
        id: `${sessionId}:${step.step_index}:prompt`,
        kind: 'prompt',
        icon: '💬',
        text: truncate(text, 46),
        detail: truncate(text, 300),
        at,
      });
      status = 'working';
    }
  }

  // 2. Resposta do modelo / Pensamento / Chamadas de ferramentas
  if (step.type === 'PLANNER_RESPONSE') {
    status = 'working';

    // Pensamento (thinking)
    if (step.thinking && step.thinking.trim()) {
      activities.push({
        id: `${sessionId}:${step.step_index}:think`,
        kind: 'think',
        icon: '🧠',
        text: 'Pensando...',
        detail: truncate(step.thinking, 300),
        at,
      });
    }

    // Ferramentas chamadas
    if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
      for (let i = 0; i < step.tool_calls.length; i++) {
        const tc = step.tool_calls[i];
        const args = tc.args || {};
        const toolId = `${sessionId}:${step.step_index}:tc:${i}`;

        switch (tc.name) {
          case 'run_command': {
            const cmd = cleanStr(args.CommandLine);
            const isTest = /(?:pytest|npm\s+test|vitest|cargo\s+test|go\s+test|mvn\s+test|composer\s+test)/i.test(cmd);
            activities.push({
              id: toolId,
              kind: isTest ? 'test' : 'run',
              icon: isTest ? '🧪' : '💻',
              text: truncate(cmd ? `$ ${cmd}` : 'Executando comando', 46),
              detail: truncate(cmd, 300),
              tool: 'run_command',
              at,
            });
            break;
          }
          case 'view_file': {
            const p = cleanStr(args.AbsolutePath);
            activities.push({
              id: toolId,
              kind: 'read',
              icon: '📖',
              text: truncate(p ? `Lendo ${basename(p)}` : 'Lendo arquivo', 46),
              detail: truncate(p, 300),
              tool: 'view_file',
              at,
            });
            break;
          }
          case 'replace_file_content':
          case 'write_to_file': {
            const p = cleanStr(args.TargetFile);
            activities.push({
              id: toolId,
              kind: 'edit',
              icon: '✏️',
              text: truncate(p ? `Editando ${basename(p)}` : 'Editando arquivo', 46),
              detail: truncate(p, 300),
              tool: tc.name,
              at,
            });
            break;
          }
          case 'search_web': {
            const q = cleanStr(args.query);
            activities.push({
              id: toolId,
              kind: 'search',
              icon: '🌐',
              text: truncate(q ? `Pesquisando: ${q}` : 'Pesquisando na web', 46),
              detail: truncate(q, 300),
              tool: 'search_web',
              at,
            });
            break;
          }
          case 'read_url_content': {
            const u = cleanStr(args.Url);
            activities.push({
              id: toolId,
              kind: 'web',
              icon: '🌐',
              text: truncate(u ? `Acessando ${u}` : 'Acessando URL', 46),
              detail: truncate(u, 300),
              tool: 'read_url_content',
              at,
            });
            break;
          }
          case 'call_mcp_tool': {
            const srv = cleanStr(args.ServerName);
            const tool = cleanStr(args.ToolName);
            const isBrowser = srv.includes('playwright') || srv.includes('chrome-devtools');
            activities.push({
              id: toolId,
              kind: isBrowser ? 'browser' : 'mcp',
              icon: isBrowser ? '🌐' : '🔌',
              text: truncate(tool ? `${srv}/${tool}` : 'Chamando ferramenta MCP', 46),
              detail: truncate(`${srv}/${tool}`, 300),
              tool: `mcp:${srv}`,
              at,
            });
            break;
          }
          case 'invoke_subagent': {
            activities.push({
              id: toolId,
              kind: 'delegate',
              icon: '📦',
              text: 'Disparando subagente',
              tool: 'invoke_subagent',
              at,
            });
            break;
          }
          case 'ask_question': {
            let qText = 'Pergunta interativa no terminal';
            if (Array.isArray(args.questions) && args.questions.length > 0) {
              const firstQ = args.questions[0];
              if (firstQ && typeof firstQ === 'object' && 'question' in firstQ) {
                qText = cleanStr((firstQ as { question: unknown }).question);
              }
            }
            activities.push({
              id: toolId,
              kind: 'ask',
              icon: '✋',
              text: 'Aguardando sua resposta',
              detail: truncate(qText, 300),
              tool: 'ask_question',
              at,
            });
            status = 'waiting';
            waitingFor = qText;
            break;
          }
          default: {
            activities.push({
              id: toolId,
              kind: 'other',
              icon: '⚙️',
              text: truncate(`Ferramenta: ${tc.name}`, 46),
              tool: tc.name,
              at,
            });
            break;
          }
        }
      }
    } else if (step.content && step.content.trim()) {
      // Resposta textual final do turno
      activities.push({
        id: `${sessionId}:${step.step_index}:respond`,
        kind: 'respond',
        icon: '💬',
        text: 'Respondendo...',
        detail: truncate(step.content, 300),
        at,
      });
      // Se concluiu a resposta textual e não tem tool_calls, o turno pode estar finalizando
      if (step.status === 'DONE') {
        status = 'idle';
      }
    }
  }

  return { activities, status, waitingFor };
}
