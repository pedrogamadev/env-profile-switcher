/**
 * Regras puras usadas pela extensão (sem "vscode"), testáveis com node:test.
 */
import { EnvGroup, EnvOption, LineEdit, ParseResult, activeOption, computeSelection, splitLines } from './parser';

export const DEFAULT_GUARD_PATTERNS = [
  'prisma\\s+migrate\\s+(dev|reset|deploy)',
  'prisma\\s+db\\s+(push|seed)',
  'typeorm\\b.*\\bmigration:run',
  'sequelize\\b.*\\bdb:migrate',
  'knex\\b.*\\bmigrate:latest',
];

/** true se a linha de comando bate com algum padrão (regex, sem diferenciar maiúsculas). */
export function matchesGuard(commandLine: string, patterns: readonly string[]): boolean {
  const cmd = commandLine.trim();
  if (!cmd) return false;
  return patterns.some((p) => {
    try {
      return new RegExp(p, 'i').test(cmd);
    } catch {
      return false; // padrão inválido na configuração é ignorado
    }
  });
}

function normalize(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\bnpm run(?:-script)? start(?=\s|$)/g, 'npm start');
}

/** true se a linha de comando digitada é o comando do servidor configurado. */
export function commandMatches(commandLine: string, configured: string): boolean {
  const cmd = normalize(commandLine);
  const target = normalize(configured);
  return !!cmd && !!target && cmd.includes(target);
}

export interface DangerActive {
  group: EnvGroup;
  option: EnvOption;
}

/** Opções @danger que estão ativas (total ou parcialmente). */
export function activeDangers(result: ParseResult | undefined): DangerActive[] {
  if (!result || result.errors.length > 0) return [];
  const out: DangerActive[] = [];
  for (const group of result.groups) {
    for (const option of group.options) {
      if (option.danger && option.state !== 'inactive') out.push({ group, option });
    }
  }
  return out;
}

/** Opção segura do grupo: prefere a chamada "local"; senão, a primeira sem @danger. */
export function safeOption(group: EnvGroup): EnvOption | undefined {
  const safe = group.options.filter((o) => !o.danger);
  return safe.find((o) => o.name.toLowerCase() === 'local') ?? safe[0];
}

export interface AllLocalPlan {
  edits: LineEdit[];
  changed: { group: string; from: string; to: string }[];
  skipped: string[];
}

/**
 * Calcula as edições para tirar todos os grupos de opções @danger,
 * levando cada um para a sua opção segura.
 */
export function planAllLocal(text: string, result: ParseResult): AllLocalPlan {
  const plan: AllLocalPlan = { edits: [], changed: [], skipped: [] };
  for (const group of result.groups) {
    const touchesDanger = group.options.some((o) => o.danger && o.state !== 'inactive');
    if (!touchesDanger) continue;
    const target = safeOption(group);
    if (!target) {
      plan.skipped.push(group.name);
      continue;
    }
    const sel = computeSelection(text, group.name, target.name);
    plan.edits.push(...sel.edits);
    plan.changed.push({ group: group.name, from: activeOption(group)?.name ?? '?', to: target.name });
  }
  return plan;
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Comando para rodar um script conforme o gerenciador de pacotes. "start" no npm vira "npm start". */
export function scriptCommand(pm: PackageManager, script: string): string {
  if (pm === 'npm') return script === 'start' ? 'npm start' : `npm run ${script}`;
  if (pm === 'bun') return `bun run ${script}`;
  return `${pm} ${script}`;
}

/** Detecta o gerenciador pelo nome dos lockfiles presentes na pasta. */
export function detectPackageManager(files: readonly string[]): PackageManager {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('bun.lockb') || files.includes('bun.lock')) return 'bun';
  return 'npm';
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];

/** A pasta tem algum lockfile? Sem lockfile, vale procurar na pasta de cima (monorepo). */
export function hasLockfile(files: readonly string[]): boolean {
  return files.some((f) => LOCKFILES.includes(f));
}

/** Os scripts de um package.json já parseado, ignorando o que não for texto. */
export function packageScripts(pkg: unknown): Record<string, string> {
  if (typeof pkg !== 'object' || pkg === null) return {};
  const scripts: unknown = (pkg as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || scripts === null) return {};
  return Object.fromEntries(
    Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/** Scripts que parecem iniciar um servidor de desenvolvimento, em ordem de relevância. */
export function rankDevScripts(scripts: Record<string, string>): string[] {
  const score = (name: string): number => {
    if (/^start:dev$/.test(name)) return 0;
    if (/^dev$/.test(name)) return 1;
    if (/dev|watch|serve/.test(name)) return 2;
    if (/^start$/.test(name)) return 3;
    return 9;
  };
  return Object.keys(scripts)
    .filter((n) => !/^(pre|post)/.test(n))
    .sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}

// ───────────────────────── Serviços ─────────────────────────

export interface ServiceDef {
  /** Sistema ao qual o serviço pertence (ex.: "Loja"). */
  system: string;
  /** Nome curto (ex.: "back", "front"). */
  name: string;
  /** Pasta do workspace (nome), em workspaces com várias pastas. Vazio = primeira pasta. */
  folder?: string;
  /** Pasta onde roda o comando, relativa à pasta do workspace. */
  cwd?: string;
  command: string;
  port?: number;
}

export function serviceId(def: ServiceDef): string {
  return `${def.system} · ${def.name}`;
}

/** Valida e normaliza a lista vinda das configurações. */
export function normalizeServices(raw: unknown): ServiceDef[] {
  if (!Array.isArray(raw)) return [];
  const out: ServiceDef[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const command = typeof o.command === 'string' ? o.command.trim() : '';
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!command || !name) continue;
    const def: ServiceDef = {
      system: typeof o.system === 'string' && o.system.trim() ? o.system.trim() : 'Projeto',
      name,
      folder: typeof o.folder === 'string' ? o.folder.trim() : undefined,
      cwd: typeof o.cwd === 'string' ? o.cwd.trim().replace(/^[.\\/]+$/, '') : undefined,
      command,
      port: typeof o.port === 'number' && o.port > 0 && o.port < 65536 ? Math.floor(o.port) : undefined,
    };
    const id = serviceId(def);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(def);
  }
  return out;
}

/** Normaliza um caminho para comparação (barras, maiúsculas no Windows, barra final). */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** O serviço lê o .env desta pasta? (o dotenv lê o .env da pasta onde o processo roda) */
export function serviceUsesEnvDir(serviceDir: string, envDir: string): boolean {
  return normPath(serviceDir) === normPath(envDir);
}

export type PackageKind = 'back' | 'front' | undefined;

/** Tenta descobrir se o package.json é de back-end ou front-end pelas dependências. */
export function classifyPackage(pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): PackageKind {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const has = (re: RegExp) => Object.keys(deps).some((d) => re.test(d));
  if (has(/^@nestjs\/core$|^express$|^fastify$|^koa$|^@hapi\/hapi$|^hono$/)) return 'back';
  if (has(/^vite$|^next$|^react-scripts$|^@angular\/core$|^nuxt$|^@sveltejs\/kit$|^astro$/)) return 'front';
  return undefined;
}

/** Porta provável: PORT do .env da pasta, ou o padrão do framework. */
export function guessPort(kind: PackageKind, pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }, envText?: string): number | undefined {
  if (envText) {
    const m = /^\s*PORT\s*=\s*["']?(\d{2,5})/m.exec(envText);
    if (m) return Number(m[1]);
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (deps.vite) return 5173;
  if (deps.next || deps['react-scripts']) return 3000;
  if (deps['@angular/core']) return 4200;
  if (kind === 'back') return 3000;
  return undefined;
}

export interface LocalPortRef {
  group: string;
  option: string;
  key: string;
  port: number;
}

/**
 * Portas em localhost usadas pelas opções ativas dos grupos.
 * Ex.: ESTOQUE_API_URL=http://localhost:3034 ativo => depende de algo rodando na 3034.
 */
export function localPortRefs(text: string, result: ParseResult): LocalPortRef[] {
  if (result.errors.length > 0) return [];
  const lines = splitLines(text);
  const out: LocalPortRef[] = [];
  for (const g of result.groups) {
    for (const o of g.options) {
      if (o.state !== 'active') continue;
      for (const n of o.lines) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?([a-z][a-z0-9+.-]*:\/\/[^\s"']+)/i.exec(lines[n]);
        if (!m) continue;
        const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?/i.exec(m[2]);
        if (!url || !url[2]) continue;
        const host = url[1].toLowerCase().replace(/^\[|\]$/g, '');
        if (!['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host)) continue;
        out.push({ group: g.name, option: o.name, key: m[1], port: Number(url[2]) });
      }
    }
  }
  return out;
}
