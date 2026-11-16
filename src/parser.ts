/**
 * Parser puro dos marcadores do .env.
 * Não importa "vscode" para poder ser testado com node:test.
 *
 * Sintaxe:
 *   # @group <Nome>
 *   # @option <nome> [@danger]
 *   KEY=valor            (linha ativa)
 *   # KEY=valor          (linha inativa)
 *   # @end
 */

export type OptionState = 'active' | 'inactive' | 'mixed';
export type GroupState = 'valid' | 'inconsistent';

export interface EnvOption {
  name: string;
  danger: boolean;
  /** Linha (0-based) do marcador @option. */
  markerLine: number;
  /** Linhas (0-based) de atribuição pertencentes à opção. */
  lines: number[];
  /** Nomes das variáveis da opção. Nunca os valores. */
  keys: string[];
  state: OptionState;
}

export interface EnvGroup {
  name: string;
  startLine: number;
  endLine: number;
  options: EnvOption[];
  state: GroupState;
}

export interface ParseError {
  /** Linha 0-based. */
  line: number;
  message: string;
}

export interface ParseResult {
  groups: EnvGroup[];
  errors: ParseError[];
}

export interface LineEdit {
  line: number;
  newText: string;
}

export interface Selection {
  group: EnvGroup;
  option: EnvOption;
  edits: LineEdit[];
}

const GROUP_RE = /^\s*#\s*@group(?:\s+(.*?))?\s*$/;
const OPTION_RE = /^\s*#\s*@option(?:\s+(.*?))?\s*$/;
const END_RE = /^\s*#\s*@end\s*$/;
const ACTIVE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const INACTIVE_RE = /^\s*#\s?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const DANGER_TOKEN = '@danger';

/** Divide em linhas do mesmo jeito que o VS Code (\r\n, \n ou \r). */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

type LineKind =
  | { kind: 'active'; key: string }
  | { kind: 'inactive'; key: string }
  | { kind: 'other' };

export function classifyLine(line: string): LineKind {
  const a = ACTIVE_RE.exec(line);
  if (a) return { kind: 'active', key: a[1] };
  const i = INACTIVE_RE.exec(line);
  if (i) return { kind: 'inactive', key: i[1] };
  return { kind: 'other' };
}

/** Remove o primeiro "#" e um único espaço seguinte, preservando a indentação. */
export function activateLine(line: string): string {
  if (classifyLine(line).kind !== 'inactive') return line;
  return line.replace(/^(\s*)# ?/, '$1');
}

/** Prefixa "# " depois da indentação. */
export function deactivateLine(line: string): string {
  if (classifyLine(line).kind !== 'active') return line;
  return line.replace(/^(\s*)/, '$1# ');
}

interface OpenGroup {
  name: string;
  startLine: number;
  options: EnvOption[];
}

export function parseEnv(text: string): ParseResult {
  const lines = splitLines(text);
  const groups: EnvGroup[] = [];
  const errors: ParseError[] = [];
  const err = (line: number, message: string) => errors.push({ line, message });

  let group: OpenGroup | undefined;
  let option: (EnvOption & { activeCount: number }) | undefined;

  const closeOption = () => {
    if (!option || !group) return;
    const { activeCount, ...opt } = option;
    if (opt.lines.length === 0) {
      err(opt.markerLine, `A opção "${opt.name}" não tem nenhuma variável`);
    }
    opt.state =
      activeCount === opt.lines.length ? 'active' : activeCount === 0 ? 'inactive' : 'mixed';
    group.options.push(opt);
    option = undefined;
  };

  const closeGroup = (endLine: number) => {
    if (!group) return;
    closeOption();
    if (group.options.length === 0) {
      err(group.startLine, `O grupo "${group.name}" não tem nenhuma @option`);
    }
    const activeCount = group.options.filter((o) => o.state === 'active').length;
    const hasMixed = group.options.some((o) => o.state === 'mixed');
    groups.push({
      name: group.name,
      startLine: group.startLine,
      endLine,
      options: group.options,
      state: activeCount === 1 && !hasMixed ? 'valid' : 'inconsistent',
    });
    group = undefined;
  };

  lines.forEach((line, n) => {
    const g = GROUP_RE.exec(line);
    if (g) {
      const name = (g[1] ?? '').trim();
      if (group) {
        err(n, `"@group" aberto antes de fechar o grupo "${group.name}" (falta "# @end")`);
        closeGroup(n - 1);
      }
      if (!name) {
        err(n, '"@group" sem nome');
      } else if (groups.some((x) => x.name === name)) {
        err(n, `Grupo "${name}" duplicado`);
      }
      group = { name: name || '(sem nome)', startLine: n, options: [] };
      return;
    }

    const o = OPTION_RE.exec(line);
    if (o) {
      if (!group) {
        err(n, '"@option" fora de um "@group"');
        return;
      }
      closeOption();
      const tokens = (o[1] ?? '').split(/\s+/).filter(Boolean);
      const danger = tokens.length > 0 && tokens[tokens.length - 1] === DANGER_TOKEN;
      if (danger) tokens.pop();
      const name = tokens.join(' ');
      if (!name) {
        err(n, '"@option" sem nome');
      } else if (group.options.some((x) => x.name === name)) {
        err(n, `Opção "${name}" duplicada no grupo "${group.name}"`);
      }
      option = {
        name: name || '(sem nome)',
        danger,
        markerLine: n,
        lines: [],
        keys: [],
        state: 'inactive',
        activeCount: 0,
      };
      return;
    }

    if (END_RE.test(line)) {
      if (!group) {
        err(n, '"@end" sem "@group" correspondente');
        return;
      }
      closeGroup(n);
      return;
    }

    if (!group) return;
    const kind = classifyLine(line);
    if (kind.kind === 'other') return;
    if (!option) {
      err(n, `Variável "${kind.key}" dentro do grupo "${group.name}" antes de qualquer "@option"`);
      return;
    }
    option.lines.push(n);
    if (!option.keys.includes(kind.key)) option.keys.push(kind.key);
    if (kind.kind === 'active') option.activeCount++;
  });

  if (group) {
    const open: OpenGroup = group;
    err(open.startLine, `O grupo "${open.name}" não foi fechado (falta "# @end")`);
    closeGroup(lines.length - 1);
  }

  errors.sort((a, b) => a.line - b.line);
  return { groups, errors };
}

export function formatError(e: ParseError): string {
  return `Linha ${e.line + 1}: ${e.message}`;
}

/**
 * Calcula as edições para ativar `optionName` e desativar as outras opções do mesmo grupo.
 * Lança erro se o arquivo tiver erros de parse ou se grupo/opção não existirem.
 */
export function computeSelection(text: string, groupName: string, optionName: string): Selection {
  const result = parseEnv(text);
  if (result.errors.length > 0) {
    throw new Error(formatError(result.errors[0]));
  }
  const group = result.groups.find((g) => g.name === groupName);
  if (!group) throw new Error(`Grupo "${groupName}" não encontrado`);
  const option = group.options.find((o) => o.name === optionName);
  if (!option) throw new Error(`Opção "${optionName}" não encontrada no grupo "${groupName}"`);

  const lines = splitLines(text);
  const edits: LineEdit[] = [];
  for (const opt of group.options) {
    const shouldBeActive = opt === option;
    for (const n of opt.lines) {
      const current = lines[n];
      const next = shouldBeActive ? activateLine(current) : deactivateLine(current);
      if (next !== current) edits.push({ line: n, newText: next });
    }
  }
  return { group, option, edits };
}

/** Aplica edições linha a linha preservando o terminador original de cada linha. */
export function applyEdits(text: string, edits: LineEdit[]): string {
  if (edits.length === 0) return text;
  const parts = text.split(/(\r\n|\r|\n)/);
  const byLine = new Map(edits.map((e) => [e.line, e.newText]));
  for (let i = 0; i < parts.length; i += 2) {
    const line = i / 2;
    const replacement = byLine.get(line);
    if (replacement !== undefined) parts[i] = replacement;
  }
  return parts.join('');
}

export function activeOption(group: EnvGroup): EnvOption | undefined {
  if (group.state !== 'valid') return undefined;
  return group.options.find((o) => o.state === 'active');
}
