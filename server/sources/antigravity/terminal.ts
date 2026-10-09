// Terminal do Antigravity CLI: converte as etapas do transcript.jsonl em TerminalEntry
// (prompts do usuário, raciocínio thinking, chamadas de ferramentas e seus resultados),
// com segredos mascarados e textos formatados pelas convenções do Habblaud.
import type { TerminalEntry, TerminalInputKind } from '../../../shared/types';
import { maskSecrets } from '../../../shared/activity';
import { marked, oneLine, prepare, INPUT_MAX, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, type TerminalParser } from '../terminal';

type Rec = Record<string, unknown>;

const SEEN_MAX = 20_000;
const TITLE_ARG_MAX = 100;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function cleanStr(v: unknown): string {
  if (typeof v === 'string') {
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

function titled(label: string, arg?: string): string {
  const shown = arg ? oneLine(arg, TITLE_ARG_MAX, false) : '';
  return shown ? `${label}(${shown})` : label;
}

export class AntigravityTerminalParser implements TerminalParser {
  private out: TerminalEntry[] = [];
  private readonly seen = new Set<string>();
  private lastToolUseId?: string;

  constructor(private readonly sessionId: string = 'antigravity') {}

  push(line: string): TerminalEntry[] {
    this.out = [];
    if (!line.trim()) return [];
    try {
      this.parseLine(line);
    } catch {
      // Ignora linhas com erro de formato sem quebrar o stream
    }
    return this.out;
  }

  private emit(e: TerminalEntry): void {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    if (this.seen.size > SEEN_MAX) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
    this.out.push(e);
  }

  private parseLine(raw: string): void {
    const step = JSON.parse(raw);
    if (!step || typeof step !== 'object') return;

    const stepIndex = typeof step.step_index === 'number' ? step.step_index : 0;
    const at = step.created_at ? new Date(step.created_at).getTime() : Date.now();
    const type = step.type;

    // 1. Mensagem do Usuário
    if (type === 'USER_INPUT' && step.content) {
      const rawText = cleanStr(step.content)
        .replace(/<USER_REQUEST>|<\/USER_REQUEST>|<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>|<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
        .trim();

      if (rawText) {
        const prep = prepare(rawText, TEXT_MAX);
        this.emit({
          kind: 'user',
          id: `${this.sessionId}:${stepIndex}:user`,
          at,
          text: marked(prep),
        });
      }
      return;
    }

    // 2. Resposta do Modelo (Planejamento, Raciocínio, Ferramentas)
    if (type === 'PLANNER_RESPONSE') {
      // Raciocínio (thinking)
      if (step.thinking && typeof step.thinking === 'string' && step.thinking.trim()) {
        const prep = prepare(step.thinking, THINKING_MAX);
        this.emit({
          kind: 'thinking',
          id: `${this.sessionId}:${stepIndex}:think`,
          at,
          text: marked(prep),
        });
      }

      // Chamadas de Ferramentas
      if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
        for (let i = 0; i < step.tool_calls.length; i++) {
          const tc = step.tool_calls[i];
          const toolName = tc.name || 'tool';
          const args = rec(tc.args) || {};
          const toolId = `${this.sessionId}:${stepIndex}:tc:${i}`;
          this.lastToolUseId = toolId;

          let title = toolName;
          let input: string | undefined;
          let inputKind: TerminalInputKind | undefined;

          switch (toolName) {
            case 'run_command': {
              const cmd = cleanStr(args.CommandLine);
              title = titled('Bash', cmd);
              input = cmd ? prepare(cmd, INPUT_MAX, Infinity, false).text : undefined;
              inputKind = 'bash';
              break;
            }
            case 'view_file': {
              const p = cleanStr(args.AbsolutePath);
              title = titled('Read', p);
              input = p;
              break;
            }
            case 'replace_file_content': {
              const p = cleanStr(args.TargetFile);
              const repl = cleanStr(args.ReplacementContent);
              title = titled('Edit', p);
              input = repl ? prepare(repl, INPUT_MAX, Infinity, false).text : undefined;
              inputKind = 'diff';
              break;
            }
            case 'write_to_file': {
              const p = cleanStr(args.TargetFile);
              const code = cleanStr(args.CodeContent);
              title = titled('Write', p);
              input = code ? prepare(code, INPUT_MAX, Infinity, false).text : undefined;
              inputKind = 'diff';
              break;
            }
            case 'search_web': {
              const q = cleanStr(args.query);
              title = titled('Search', q);
              input = q;
              break;
            }
            case 'read_url_content': {
              const u = cleanStr(args.Url);
              title = titled('Fetch', u);
              input = u;
              break;
            }
            case 'call_mcp_tool': {
              const srv = cleanStr(args.ServerName);
              const tool = cleanStr(args.ToolName);
              title = titled(`${srv}/${tool}`);
              if (args.Arguments) {
                input = prepare(JSON.stringify(args.Arguments, null, 2), INPUT_MAX, Infinity, false).text;
                inputKind = 'json';
              }
              break;
            }
            case 'ask_question': {
              title = 'Pergunta ao usuário';
              input = JSON.stringify(args.questions || {}, null, 2);
              inputKind = 'json';
              break;
            }
            default: {
              title = titled(toolName);
              input = Object.keys(args).length ? JSON.stringify(args, null, 2) : undefined;
              inputKind = 'json';
              break;
            }
          }

          this.emit({
            kind: 'tool',
            id: toolId,
            at,
            tool: toolName,
            title,
            input,
            inputKind,
          });
        }
      }

      // Resposta textual final
      if (step.content && typeof step.content === 'string' && step.content.trim()) {
        const prep = prepare(step.content, TEXT_MAX);
        this.emit({
          kind: 'assistant',
          id: `${this.sessionId}:${stepIndex}:assistant`,
          at,
          text: marked(prep),
        });
      }
      return;
    }

    // 3. Resultado de Ferramenta (GENERIC)
    if (type === 'GENERIC' && step.content && this.lastToolUseId) {
      const rawRes = cleanStr(step.content);
      const prep = prepare(rawRes, RESULT_MAX, RESULT_MAX_LINES, false);
      this.emit({
        kind: 'result',
        id: `${this.sessionId}:${stepIndex}:result`,
        at,
        toolUseId: this.lastToolUseId,
        text: prep.text,
        truncated: prep.truncated,
        error: /failed|error|fatal|exception/i.test(prep.text.slice(0, 100)),
      });
      return;
    }

    // 4. Mensagem Efêmera / Sistema
    if (type === 'EPHEMERAL_MESSAGE' && step.content) {
      const txt = cleanStr(step.content).trim();
      if (txt.startsWith('> 🧭')) {
        this.emit({
          kind: 'system',
          id: `${this.sessionId}:${stepIndex}:sys`,
          at,
          text: 'ai-memory carregado',
          detail: txt,
          level: 'info',
        });
      }
    }
  }
}

export function createAntigravityTerminalParser(sessionId?: string): AntigravityTerminalParser {
  return new AntigravityTerminalParser(sessionId);
}
