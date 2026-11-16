/**
 * Organização automática do .env (puro, sem "vscode").
 *
 * Encontra variáveis que aparecem mais de uma vez (uma ativa e outras comentadas),
 * dá nome a cada variante (local, teste, homolog, supabase...), junta as variáveis
 * que mudam juntas e gera o texto com os marcadores # @group / # @option / # @end.
 */
import { parseEnv, formatError } from './parser';

const ASSIGN_RE = /^(\s*)(#\s?)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const MARKER_RE = /^\s*#\s*@(group|option|end)\b/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', 'host.docker.internal']);
const PROVIDERS = ['supabase', 'neon', 'render', 'railway', 'planetscale', 'heroku', 'vercel', 'mongodb', 'upstash', 'aiven', 'digitalocean', 'azure', 'amazonaws'];

export interface Variant {
  line: number;
  key: string;
  active: boolean;
  value: string;
  host?: string;
  label: string;
  danger: boolean;
  /** Linha do comentário usado como rótulo (removida na organização). */
  labelLine?: number;
}

export interface ProposedOption {
  name: string;
  danger: boolean;
  lines: number[];
}

export interface ProposedGroup {
  name: string;
  keys: string[];
  options: ProposedOption[];
}

export interface Proposal {
  groups: ProposedGroup[];
  newText: string;
  removedComments: number[];
}

export interface OrganizeOptions {
  /** Restringe às linhas selecionadas (0-based) e junta tudo num grupo só. */
  onlyLines?: ReadonlySet<number>;
  groupName?: string;
}

function stripQuotes(v: string): string {
  const t = v.trim().replace(/\s+#.*$/, '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** Host de um valor que parece URL, em minúsculas. */
export function hostOf(value: string): string | undefined {
  const v = stripQuotes(value);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return undefined;
  try {
    const h = new URL(v).hostname.toLowerCase();
    if (h) return h.replace(/^\[|\]$/g, '');
  } catch {
    /* cai no regex abaixo */
  }
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(v);
  return m ? m[1].toLowerCase().replace(/^\[|\]$/g, '') : undefined;
}

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host) || LOCAL_HOSTS.has(`[${host}]`);
}

function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Rótulo vindo de um comentário curto ("#local", "# Homolog", "API ... (homolog)"). */
export function labelFromComment(comment: string | undefined): string | undefined {
  if (!comment) return undefined;
  const text = comment.replace(/^\s*#+\s*/, '').trim();
  if (!text || MARKER_RE.test(comment)) return undefined;
  const paren = /\(([^()]{1,20})\)\s*$/.exec(text);
  if (paren) return slug(paren[1]) || undefined;
  if (text.length <= 20 && text.split(/\s+/).length <= 2) return slug(text) || undefined;
  return undefined;
}

function labelFromHost(host: string, value: string): string {
  if (isLocalHost(host)) {
    const path = stripQuotes(value).split(/[?#]/)[0];
    const db = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    return /test|teste|valida/.test(db) ? 'teste' : 'local';
  }
  if (/homolog|\bhml\b/.test(host)) return 'homolog';
  if (/staging|\bstg\b/.test(host)) return 'staging';
  if (/(^|[.-])prod/.test(host)) return 'producao';
  const provider = PROVIDERS.find((p) => host.includes(p));
  if (provider) return provider === 'amazonaws' ? 'aws' : provider;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return 'rede-interna';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return 'remoto';
  const labels = host.split('.');
  return slug(labels.length > 2 ? labels[labels.length - 2] : labels[0]) || 'remoto';
}

function labelFromValue(value: string): string {
  const v = stripQuotes(value);
  if (v.length > 0 && v.length <= 20 && /^[\w.-]+$/.test(v)) return slug(v) || 'opcao';
  return 'opcao';
}

function isDangerLabel(label: string): boolean {
  return /homolog|staging|prod|remoto/.test(label);
}

/** Nome do grupo a partir das variáveis. */
export function groupNameFor(keys: string[]): string {
  const all = keys.join(' ');
  if (/DATABASE|POSTGRES|MYSQL|MONGO|(^|_)DB(_|$)|DIRECT_URL/.test(all)) return 'Banco';
  if (/REDIS/.test(all)) return 'Redis';
  if (/NODE_ENV|APP_ENV|ENVIRONMENT/.test(all)) return 'Ambiente';
  const k = keys[0].replace(/_(URL|URI|HOST|ENDPOINT|BASE_URL|ADDR)$/, '');
  const words = k.toLowerCase().split('_').filter(Boolean);
  if (words.length === 0) return 'Grupo';
  const name = words.join(' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Lista as variantes (linhas de atribuição fora de grupos já existentes). */
export function collectVariants(text: string, opts: OrganizeOptions = {}): { variants: Variant[]; lines: string[] } {
  const lines = text.split(/\r\n|\r|\n/);
  const parsed = parseEnv(text);
  if (parsed.errors.length > 0) throw new Error(formatError(parsed.errors[0]));
  const inGroup = new Set<number>();
  for (const g of parsed.groups) for (let i = g.startLine; i <= g.endLine; i++) inGroup.add(i);

  const variants: Variant[] = [];
  lines.forEach((raw, n) => {
    if (inGroup.has(n)) return;
    if (opts.onlyLines && !opts.onlyLines.has(n)) return;
    const m = ASSIGN_RE.exec(raw);
    if (!m) return;
    const [, , hash, key, value] = m;
    const host = hostOf(value);
    const prev = n > 0 ? lines[n - 1] : undefined;
    const prevIsComment = !!prev && /^\s*#/.test(prev) && !ASSIGN_RE.test(prev) && !inGroup.has(n - 1);
    const commentLabel = prevIsComment ? labelFromComment(prev) : undefined;
    const label = commentLabel ?? (host ? labelFromHost(host, value) : labelFromValue(value));
    const danger = host ? !isLocalHost(host) : isDangerLabel(label);
    variants.push({
      line: n,
      key,
      active: !hash,
      value,
      host,
      label,
      danger,
      labelLine: commentLabel ? n - 1 : undefined,
    });
  });
  return { variants, lines };
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const p = this.parent.get(x)!;
    if (p === x) return x;
    const r = this.find(p);
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b));
  }
}

/** Monta a proposta de organização e o texto resultante. */
export function proposeOrganization(text: string, opts: OrganizeOptions = {}): Proposal {
  const { variants, lines } = collectVariants(text, opts);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';

  const byKey = new Map<string, Variant[]>();
  for (const v of variants) byKey.set(v.key, [...(byKey.get(v.key) ?? []), v]);

  // Variáveis com alternativas (2+ ocorrências). Na seleção manual, todas entram.
  const multiKeys = [...byKey.keys()].filter((k) => opts.onlyLines || byKey.get(k)!.length >= 2);
  if (multiKeys.length === 0) return { groups: [], newText: text, removedComments: [] };

  // Rótulos repetidos dentro da mesma variável ganham sufixo.
  for (const k of multiKeys) {
    const seen = new Map<string, number>();
    for (const v of byKey.get(k)!) {
      const count = (seen.get(v.label) ?? 0) + 1;
      seen.set(v.label, count);
      if (count > 1) v.label = `${v.label}-${count}`;
    }
  }

  const uf = new UnionFind();
  multiKeys.forEach((k) => uf.find(k));
  if (opts.onlyLines) {
    multiKeys.forEach((k) => uf.union(k, multiKeys[0]));
  } else {
    // Junta variáveis com o mesmo conjunto de rótulos que estão perto uma da outra.
    for (let i = 0; i < multiKeys.length; i++) {
      for (let j = i + 1; j < multiKeys.length; j++) {
        const a = byKey.get(multiKeys[i])!;
        const b = byKey.get(multiKeys[j])!;
        const la = a.map((v) => v.label).sort().join('|');
        const lb = b.map((v) => v.label).sort().join('|');
        const near = a.some((x) => b.some((y) => Math.abs(x.line - y.line) <= 8));
        if (la === lb && near) uf.union(multiKeys[i], multiKeys[j]);
      }
    }
  }

  // Variáveis únicas coladas numa variante e no mesmo host entram na opção dela (ex.: DIRECT_URL).
  const attached = new Map<number, Variant>();
  if (!opts.onlyLines) {
    for (const [k, vs] of byKey) {
      if (vs.length !== 1 || multiKeys.includes(k)) continue;
      const single = vs[0];
      if (!single.host) continue;
      const anchor = variants.find(
        (v) => multiKeys.includes(v.key) && v.host === single.host && Math.abs(v.line - single.line) <= 2,
      );
      if (anchor) {
        single.label = anchor.label;
        single.danger = anchor.danger;
        attached.set(single.line, anchor);
      }
    }
  }

  // Monta os grupos.
  const clusters = new Map<string, string[]>();
  for (const k of multiKeys) {
    const root = uf.find(k);
    clusters.set(root, [...(clusters.get(root) ?? []), k]);
  }

  const groups: (ProposedGroup & { anchor: number; members: number[] })[] = [];
  const usedNames = new Set<string>();
  for (const keys of clusters.values()) {
    const members = variants.filter(
      (v) => keys.includes(v.key) || (attached.has(v.line) && keys.includes(attached.get(v.line)!.key)),
    );
    const optionMap = new Map<string, ProposedOption & { first: number }>();
    for (const v of members) {
      const o = optionMap.get(v.label) ?? { name: v.label, danger: false, lines: [], first: v.line };
      o.lines.push(v.line);
      o.danger = o.danger || v.danger;
      o.first = Math.min(o.first, v.line);
      optionMap.set(v.label, o);
    }
    if (optionMap.size < 2) continue;
    const options = [...optionMap.values()]
      .sort((a, b) => {
        const rank = (o: ProposedOption) => (o.name === 'local' ? 0 : o.danger ? 2 : 1);
        return rank(a) - rank(b) || a.first - b.first;
      })
      .map(({ first, ...o }) => ({ ...o, lines: o.lines.sort((x, y) => x - y) }));

    let name = opts.groupName || groupNameFor(keys);
    for (let i = 2; usedNames.has(name); i++) name = `${opts.groupName || groupNameFor(keys)} ${i}`;
    usedNames.add(name);
    const memberLines = members.map((m) => m.line);
    groups.push({ name, keys, options, anchor: Math.min(...memberLines), members: memberLines });
  }

  if (groups.length === 0) return { groups: [], newText: text, removedComments: [] };

  // Comentários usados só como rótulo saem do arquivo.
  const removedComments = variants
    .filter((v) => v.labelLine !== undefined && groups.some((g) => g.members.includes(v.line)))
    .map((v) => v.labelLine!);

  const moved = new Set<number>([...groups.flatMap((g) => g.members), ...removedComments]);
  const blocks = new Map<number, string[]>();
  for (const g of groups) {
    const block = [`# @group ${g.name}`];
    for (const o of g.options) {
      block.push(`# @option ${o.name}${o.danger ? ' @danger' : ''}`);
      for (const n of o.lines) block.push(lines[n]);
    }
    block.push('# @end');
    blocks.set(g.anchor, block);
  }

  const out: string[] = [];
  lines.forEach((l, n) => {
    if (blocks.has(n)) out.push(...blocks.get(n)!);
    if (!moved.has(n)) out.push(l);
  });

  return {
    groups: groups.map(({ anchor, members, ...g }) => g),
    newText: out.join(eol),
    removedComments: removedComments.sort((a, b) => a - b),
  };
}

/** Resumo legível de uma proposta. */
export function describeProposal(p: Proposal): string[] {
  return p.groups.map(
    (g) => `${g.name}: ${g.options.map((o) => o.name + (o.danger ? ' (remoto)' : '')).join(', ')}`,
  );
}
