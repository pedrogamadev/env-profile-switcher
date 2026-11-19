/**
 * Um grupo do .env visto como tabela (puro, sem "vscode"):
 * cada linha é uma opção e cada coluna é uma variável que o sistema lê.
 * Os marcadores # @group / # @option / # @end são só a forma de guardar essa tabela no arquivo.
 */
import { EnvGroup, ParseResult, activateLine, deactivateLine, formatError, parseEnv, splitLines } from './parser';
import { collectVariants, groupNameFor, hostOf } from './organize';

export interface OptionModel {
  name: string;
  danger: boolean;
  /** Valor de cada variável (o texto depois do "="). Sem a chave = a opção não define a variável. */
  values: Record<string, string>;
  /** Linha original de cada variável, já descomentada. Mantém o texto igual quando o valor não muda. */
  origin?: Record<string, string>;
}

export interface GroupModel {
  name: string;
  /** Colunas: variáveis que o sistema lê. */
  keys: string[];
  /** Linhas: as alternativas. */
  options: OptionModel[];
  /** Índice da opção ativa (a única descomentada). -1 = nenhuma escolhida. */
  active: number;
}

export interface GroupRef {
  name: string;
  keys: string[];
}

const ASSIGN_RE = /^(\s*)(#\s?)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function has(obj: object | undefined, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

/** Nome de opção do jeito que o parser lê (espaços repetidos viram um). */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function isValidKey(key: string): boolean {
  return KEY_RE.test(key);
}

/** Variável e valor de uma linha de atribuição, ativa ou comentada. */
export function parseAssignment(line: string): { key: string; value: string; active: boolean } | undefined {
  const m = ASSIGN_RE.exec(line);
  return m ? { key: m[3], value: m[4], active: !m[2] } : undefined;
}

/**
 * Resumo de um valor sem segredos: URLs viram host:porta/banco (sem usuário e senha),
 * variáveis com cara de segredo viram "••••••". Autossuficiente: também roda dentro do editor em tabela.
 */
export function maskValue(key: string, value: string): string {
  let v = value.trim();
  const q = v.charAt(0);
  if ((q === '"' || q === "'") && v.length > 1 && v.charAt(v.length - 1) === q) v = v.slice(1, -1);
  else v = v.replace(/\s+#.*$/, '');
  if (!v) return '(vazio)';
  const url = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?([^/?#]*)([^?#]*)/i.exec(v);
  if (url) {
    const path = url[3] && url[3] !== '/' ? url[3] : '';
    const shown = url[2] + path;
    return shown ? (shown.length > 60 ? shown.slice(0, 59) + '…' : shown) : url[1] + '://';
  }
  if (/pass|pwd|secret|token|key|private|credential/i.test(key)) return '••••••';
  return v.length > 40 ? v.slice(0, 39) + '…' : v;
}

function groupLines(parsed: ParseResult): Set<number> {
  const inGroup = new Set<number>();
  for (const g of parsed.groups) for (let i = g.startLine; i <= g.endLine; i++) inGroup.add(i);
  return inGroup;
}

function parseOrThrow(text: string): ParseResult {
  const parsed = parseEnv(text);
  if (parsed.errors.length > 0) throw new Error(formatError(parsed.errors[0]));
  return parsed;
}

/** Grupos do arquivo com as variáveis de cada um (para checar conflitos). */
export function groupRefs(text: string): GroupRef[] {
  return parseEnv(text).groups.map((g) => ({ name: g.name, keys: [...new Set(g.options.flatMap((o) => o.keys))] }));
}

/** Linhas fora de grupos (ativas ou comentadas) que atribuem uma dessas variáveis. */
export function looseLines(text: string, keys: readonly string[]): number[] {
  const parsed = parseOrThrow(text);
  const inGroup = groupLines(parsed);
  const out: number[] = [];
  splitLines(text).forEach((line, n) => {
    if (inGroup.has(n)) return;
    const a = parseAssignment(line);
    if (a && keys.includes(a.key)) out.push(n);
  });
  return out;
}

/** Variáveis soltas (fora de grupos) do arquivo, para sugerir colunas. */
export function looseKeys(text: string): string[] {
  const parsed = parseEnv(text);
  if (parsed.errors.length > 0) return [];
  const inGroup = groupLines(parsed);
  const keys = new Set<string>();
  splitLines(text).forEach((line, n) => {
    if (inGroup.has(n)) return;
    const a = parseAssignment(line);
    if (a) keys.add(a.key);
  });
  return [...keys].sort();
}

/** Tabela de um grupo que já existe no arquivo. */
export function modelFromGroup(text: string, group: EnvGroup): GroupModel {
  const lines = splitLines(text);
  const keys: string[] = [];
  const options = group.options.map((o) => {
    const values: Record<string, string> = {};
    const origin: Record<string, string> = {};
    for (const n of o.lines) {
      const a = parseAssignment(lines[n]);
      if (!a || has(values, a.key)) continue;
      values[a.key] = a.value;
      origin[a.key] = activateLine(lines[n]);
      if (!keys.includes(a.key)) keys.push(a.key);
    }
    return { name: o.name, danger: o.danger, values, origin };
  });
  let active = group.options.findIndex((o) => o.state === 'active');
  if (active < 0) active = group.options.findIndex((o) => o.state === 'mixed');
  return { name: group.name, keys, options, active };
}

function uniqueOptionName(model: GroupModel, base: string): string {
  const taken = new Set(model.options.map((o) => normalizeName(o.name)));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * Traz para a tabela os valores soltos (fora de grupos) dessas variáveis: cada valor entra na opção
 * de mesmo nome (local, teste, homolog...), na opção que já usa o mesmo servidor, ou vira uma opção nova.
 * Retorna quantos valores entraram.
 */
export function mergeLoose(model: GroupModel, text: string, keys: readonly string[]): number {
  const loose = looseLines(text, keys);
  for (const k of keys) if (!model.keys.includes(k)) model.keys.push(k);
  if (loose.length === 0) return 0;
  const { variants, lines } = collectVariants(text, { onlyLines: new Set(loose) });
  let added = 0;
  for (const v of variants) {
    // O mesmo valor já está numa opção: nada a fazer.
    if (model.options.some((o) => has(o.values, v.key) && o.values[v.key].trim() === v.value.trim())) continue;
    let row = model.options.find((o) => normalizeName(o.name) === v.label && !has(o.values, v.key));
    // Mesmo servidor de outra variável da opção (ex.: DIRECT_URL no mesmo host do DATABASE_URL).
    if (!row && v.host) {
      row = model.options.find((o) => !has(o.values, v.key) && Object.values(o.values).some((x) => hostOf(x) === v.host));
    }
    if (!row && v.active && model.active >= 0 && !has(model.options[model.active].values, v.key)) {
      row = model.options[model.active];
    }
    if (!row) {
      row = { name: uniqueOptionName(model, v.label), danger: v.danger, values: {}, origin: {} };
      model.options.push(row);
    }
    row.values[v.key] = v.value;
    row.origin = { ...(row.origin ?? {}), [v.key]: activateLine(lines[v.line]) };
    if (v.active && model.active < 0) model.active = model.options.indexOf(row);
    added++;
  }
  return added;
}

/** Tabela nova a partir das variáveis soltas (ex.: DATABASE_URL ativa e outras comentadas). */
export function modelFromLoose(text: string, keys: readonly string[], name?: string): GroupModel {
  const model: GroupModel = { name: name ?? (keys.length ? groupNameFor([...keys]) : ''), keys: [], options: [], active: -1 };
  mergeLoose(model, text, keys);
  // local primeiro, remotos por último (como o "Organizar .env").
  const rank = (o: OptionModel) => (normalizeName(o.name) === 'local' ? 0 : o.danger ? 2 : 1);
  const activeRow = model.options[model.active];
  model.options = model.options.map((o, i) => ({ o, i })).sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i).map((x) => x.o);
  model.active = activeRow ? model.options.indexOf(activeRow) : -1;
  return model;
}

/** Linha de uma variável: a original, se o valor não mudou; senão KEY=valor. Sempre ativa. */
function lineFor(option: OptionModel, key: string): string {
  const value = option.values[key];
  const orig = has(option.origin, key) ? option.origin![key] : undefined;
  const parsed = orig !== undefined ? parseAssignment(orig) : undefined;
  return parsed && parsed.key === key && parsed.value === value ? activateLine(orig!) : `${key}=${value}`;
}

/** Os marcadores e as linhas do grupo, prontos para o .env. */
export function renderGroup(model: GroupModel): string[] {
  const out = [`# @group ${normalizeName(model.name)}`];
  model.options.forEach((o, i) => {
    out.push(`# @option ${normalizeName(o.name)}${o.danger ? ' @danger' : ''}`);
    for (const key of model.keys) {
      if (!has(o.values, key)) continue;
      const line = lineFor(o, key);
      out.push(i === model.active ? line : deactivateLine(line));
    }
  });
  out.push('# @end');
  return out;
}

/** Problemas que impedem salvar a tabela. `others` = os outros grupos do arquivo. */
export function validateModel(model: GroupModel, others: readonly GroupRef[]): string[] {
  const errors: string[] = [];
  const name = normalizeName(model.name);
  if (!name) errors.push('Dê um nome ao grupo.');
  else if (others.some((g) => g.name === name)) errors.push(`Já existe um grupo chamado "${name}".`);

  if (model.keys.length === 0) errors.push('Adicione pelo menos uma variável (coluna), por exemplo DATABASE_URL.');
  const seenKeys = new Set<string>();
  for (const k of model.keys) {
    if (!isValidKey(k)) errors.push(`"${k}" não é um nome de variável válido (use letras, números e _).`);
    else if (seenKeys.has(k)) errors.push(`A variável ${k} aparece duas vezes.`);
    seenKeys.add(k);
  }
  for (const g of others) {
    const shared = model.keys.filter((k) => g.keys.includes(k));
    if (shared.length) errors.push(`${shared.join(', ')} já pertence ao grupo "${g.name}". Cada variável só pode estar em um grupo.`);
  }

  if (model.options.length === 0) errors.push('Adicione pelo menos uma opção (linha).');
  const seenNames = new Set<string>();
  model.options.forEach((o, i) => {
    const n = normalizeName(o.name);
    const label = n || `${i + 1}ª opção`;
    if (!n) errors.push(`A ${label} está sem nome.`);
    else if (seenNames.has(n)) errors.push(`Há duas opções chamadas "${n}".`);
    else if (n.startsWith('@') || /\s@danger$/.test(n)) errors.push(`"${n}" não pode ser nome de opção. Para marcar como remoto, use a coluna Remoto.`);
    seenNames.add(n);
    if (!model.keys.some((k) => has(o.values, k))) errors.push(`A opção "${label}" não define nenhuma variável.`);
    for (const k of model.keys) {
      if (has(o.values, k) && /[\r\n]/.test(o.values[k])) errors.push(`O valor de ${k} em "${label}" tem quebra de linha.`);
    }
  });
  if (model.options.length > 0 && (model.active < 0 || model.active >= model.options.length)) {
    errors.push('Escolha qual opção fica ativa.');
  }
  return errors;
}

export interface ApplyResult {
  text: string;
  /** Linhas soltas dessas variáveis que entraram no grupo. */
  moved: number;
  /** Variáveis que saíram do grupo e ficaram no .env com o valor da opção ativa. */
  released: string[];
}

/**
 * Grava a tabela no texto do .env. Edição: substitui o bloco do grupo `originalName`.
 * Grupo novo: entra no lugar das linhas soltas das variáveis (ou no fim do arquivo).
 * Em ambos os casos, as linhas soltas das variáveis da tabela passam para dentro do grupo.
 */
export function applyGroupModel(text: string, model: GroupModel, originalName?: string): ApplyResult {
  const parsed = parseOrThrow(text);
  const lines = splitLines(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const remove = new Set<number>();
  let at = -1;

  const existing = originalName !== undefined ? parsed.groups.find((g) => g.name === originalName) : undefined;
  if (originalName !== undefined && !existing) throw new Error(`O grupo "${originalName}" não existe mais no .env.`);
  if (existing) {
    for (let i = existing.startLine; i <= existing.endLine; i++) remove.add(i);
    at = existing.startLine;
  }

  const loose = looseLines(text, model.keys);
  if (loose.length) {
    const { variants } = collectVariants(text, { onlyLines: new Set(loose) });
    for (const n of loose) remove.add(n);
    for (const v of variants) if (v.labelLine !== undefined) remove.add(v.labelLine); // comentário que só dizia o ambiente
  }
  if (at < 0 && remove.size) at = Math.min(...remove);

  // Colunas tiradas de um grupo existente: a variável fica no .env com o valor da opção ativa.
  const block = renderGroup(model);
  const released: string[] = [];
  if (existing) {
    const activeRow = model.options[model.active];
    const oldKeys = [...new Set(existing.options.flatMap((o) => o.keys))];
    for (const k of oldKeys) {
      if (model.keys.includes(k)) continue;
      released.push(k);
      if (activeRow && has(activeRow.values, k)) block.push(lineFor(activeRow, k));
    }
  }

  let out: string[];
  if (at < 0) {
    out = [...lines];
    const trailing = out.length > 0 && out[out.length - 1] === '' ? out.pop() : undefined;
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(...block);
    if (trailing !== undefined) out.push('');
  } else {
    out = [];
    lines.forEach((line, n) => {
      if (n === at) out.push(...block);
      if (!remove.has(n)) out.push(line);
    });
  }

  const result = out.join(eol);
  const check = parseEnv(result);
  if (check.errors.length > 0) throw new Error(`O resultado ficaria inválido: ${formatError(check.errors[0])}`);
  return { text: result, moved: loose.length, released };
}

/** Variáveis ativas (descomentadas) e seus valores, para saber se a troca mudou o ambiente. */
export function activeValues(text: string, keys: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of splitLines(text)) {
    const a = parseAssignment(line);
    if (a && a.active && keys.includes(a.key)) out.set(a.key, a.value.trim());
  }
  return out;
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()<>#+!|~]/g, (c) => '\\' + c);
}

/** A tabela em markdown (valores mascarados), para o hover no .env. */
export function groupTableMarkdown(model: GroupModel): string {
  const head = `| | Opção | ${model.keys.map((k) => '`' + k + '`').join(' | ')} |`;
  const sep = `|:-:|---|${model.keys.map(() => '---').join('|')}|`;
  const rows = model.options.map((o, i) => {
    const cells = model.keys.map((k) => (has(o.values, k) ? escapeMd(maskValue(k, o.values[k])) : '—'));
    return `| ${i === model.active ? '●' : '○'} | ${escapeMd(o.name)}${o.danger ? ' *(remoto)*' : ''} | ${cells.join(' | ')} |`;
  });
  return [head, sep, ...rows].join('\n');
}
