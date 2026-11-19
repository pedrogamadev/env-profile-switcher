import * as vscode from 'vscode';
import * as path from 'path';
import { ParseResult, activeOption, computeSelection, formatError, parseEnv, splitLines } from './parser';
import { EnvTreeProvider, EnvView, Light, Node, Suggestion } from './treeProvider';
import { EXAMPLE_ENV } from './example';
import {
  DEFAULT_GUARD_PATTERNS,
  PackageManager,
  ServiceDef,
  activeDangers,
  classifyPackage,
  detectPackageManager,
  guessPort,
  hasLockfile,
  localPortRefs,
  matchesGuard,
  normalizeServices,
  packageScripts,
  planAllLocal,
  rankDevScripts,
  scriptCommand,
} from './logic';
import { Proposal, describeProposal, proposeOrganization } from './organize';
import { RestartConfig, RestartMode, ServerManager } from './server';
import { ServiceManager } from './services';
import { DependencyWarning, ServicesTreeProvider, SvcNode } from './servicesTree';
import {
  ApplyResult,
  GroupModel,
  activeValues,
  applyGroupModel,
  groupRefs,
  looseKeys,
  mergeLoose,
  modelFromGroup,
  modelFromLoose,
  normalizeName,
  parseAssignment,
  validateModel,
} from './groupModel';
import { ApplyOutcome, openGroupEditor } from './groupEditor';
import { isEnvDocument, registerEnvAssist } from './envAssist';
import {
  LegacyRestartSettings,
  RestartCommandStore,
  StoredRestartCommand,
  normalizeFolderPath,
} from './state/restartCommandStore';

const CONFIG = 'semaforoEnv';
const NAME = 'Semáforo Env';
const DEFAULT_FILE = '.env';
const SEARCH_EXCLUDE = '**/{node_modules,.git,dist,out,build}/**';
const PREVIEW_SCHEME = 'semaforo-preview';

/** Estado de um sistema (pasta do workspace) e do seu .env. */
interface EnvContext {
  key: string;
  folder: vscode.WorkspaceFolder;
  uri?: vscode.Uri;
  text?: string;
  result?: ParseResult;
}

let tree: EnvTreeProvider;
let servicesTree: ServicesTreeProvider;
let status: vscode.StatusBarItem;
let restartStore: RestartCommandStore;
/** Reinício nos modos task e debug, que valem para o workspace inteiro. */
let workspaceServer: ServerManager;
/** Reinício no modo terminal: um por pasta de projeto, pela chave normalizada da pasta. */
const folderServers = new Map<string, ServerManager>();
let services: ServiceManager;
let watchers: vscode.FileSystemWatcher[] = [];
const contexts = new Map<string, EnvContext>();
const previews = new Map<string, string>();
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let guardAllowOnce: { cmd: string; until: number } | undefined;
let extensionUri: vscode.Uri;
let envAssist: { refresh(): void } | undefined;

// ───────────────────────── Configuração ─────────────────────────

function folders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

function conf(scope?: vscode.Uri): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG, scope);
}

function configuredFile(folder: vscode.WorkspaceFolder): string {
  return conf(folder.uri).get<string>('file', DEFAULT_FILE) || DEFAULT_FILE;
}

function fileIsExplicit(folder: vscode.WorkspaceFolder): boolean {
  const info = conf(folder.uri).inspect<string>('file');
  return !!(info?.workspaceFolderValue || info?.workspaceValue || info?.globalValue);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Grava uma configuração sem deixar o erro do VS Code escapar como exceção.
 * Retorna false (e avisa) se não conseguiu.
 */
async function writeSetting(
  key: string,
  value: unknown,
  target: vscode.ConfigurationTarget,
  scope: vscode.Uri | undefined,
  what: string,
): Promise<boolean> {
  try {
    await conf(scope).update(key, value, target);
    return true;
  } catch (e) {
    void vscode.window.showWarningMessage(
      `${NAME}: não consegui salvar ${what} nas configurações (${CONFIG}.${key}). ${errorText(e)}`,
    );
    return false;
  }
}

// ───────────────────────── Reinício simples: estado ─────────────────────────

function restartMode(): RestartMode {
  return restartStore.getMode();
}

/**
 * Caminho relativo (com "/") de um caminho de disco dentro da pasta do workspace.
 * Compara por fsPath: Uri.file() devolve "c:" e a pasta aberta pode estar como "C:".
 */
function relFsPath(folder: vscode.WorkspaceFolder, fsPath: string): string {
  return path.relative(folder.uri.fsPath, fsPath).split(path.sep).join('/');
}

/** Nome curto de uma pasta de projeto: caminho relativo à pasta do workspace (ex.: loja-api). */
function folderLabel(folderPath: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folderPath));
  if (!folder) return path.basename(folderPath) || folderPath;
  const rel = relFsPath(folder, folderPath);
  if (!rel) return folder.name;
  return folders().length > 1 ? `${folder.name}/${rel}` : rel;
}

function workspaceRestartConfig(): RestartConfig {
  const mode = restartMode();
  return {
    mode: mode === 'task' || mode === 'debug' ? mode : 'off',
    command: '',
    cwd: '',
    task: restartStore.getTask(),
  };
}

/** O ServerManager do modo terminal para uma pasta de projeto (criado na primeira vez). */
function folderServer(folderPath: string): ServerManager {
  const key = normalizeFolderPath(folderPath);
  let manager = folderServers.get(key);
  if (!manager) {
    manager = new ServerManager(() => {
      const saved = restartStore.get(key);
      return {
        mode: saved ? 'terminal' : 'off',
        command: saved?.command ?? '',
        cwd: saved?.cwd ?? '',
        task: '',
        label: saved ? folderLabel(saved.cwd) : undefined,
      };
    });
    folderServers.set(key, manager);
  }
  return manager;
}

function dropFolderServer(folderPath: string): void {
  const key = normalizeFolderPath(folderPath);
  folderServers.get(key)?.dispose();
  folderServers.delete(key);
}

/** Lê uma única vez os antigos semaforoEnv.restart.* e passa para o workspaceState. */
async function migrateRestartSettings(): Promise<void> {
  const base = folders()[0];
  if (!base) return;
  const c = conf();
  const legacy = (key: string): unknown => {
    const info = c.inspect<unknown>(`restart.${key}`);
    return info?.workspaceValue ?? info?.globalValue;
  };
  const values: LegacyRestartSettings = {
    mode: legacy('mode'),
    command: legacy('command'),
    cwd: legacy('cwd'),
    task: legacy('task'),
  };
  if (await restartStore.migrateLegacy(values, base.uri.fsPath)) {
    void vscode.window.showInformationMessage(
      `${NAME}: o reinício do servidor agora fica salvo por pasta de projeto, fora do settings.json. ` +
        `Copiei o que estava em ${CONFIG}.restart.*; essas chaves não são mais lidas e podem ser apagadas quando quiser.`,
    );
  }
}

function serviceDefs(): ServiceDef[] {
  return normalizeServices(conf().get<unknown>('services', []));
}

function joinRel(base: vscode.Uri, rel: string | undefined): vscode.Uri {
  const parts = (rel ?? '').split(/[\\/]+/).filter((p) => p && p !== '.');
  return parts.length ? vscode.Uri.joinPath(base, ...parts) : base;
}

function serviceCwd(def: ServiceDef): vscode.Uri | undefined {
  const folder = def.folder ? folders().find((f) => f.name === def.folder) : folders()[0];
  return folder ? joinRel(folder.uri, def.cwd) : undefined;
}

function relToFolder(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
  const base = folder.uri.path.replace(/\/+$/, '');
  return uri.path === base ? '' : uri.path.startsWith(base + '/') ? uri.path.slice(base.length + 1) : uri.path;
}

function sameUri(a: vscode.Uri | undefined, b: vscode.Uri | undefined): boolean {
  return !!a && !!b && a.toString() === b.toString();
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => sameUri(d.uri, uri));
  if (open) return open.getText();
  try {
    return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

// ───────────────────────── Estado dos .env ─────────────────────────

async function resolveEnvUri(folder: vscode.WorkspaceFolder): Promise<vscode.Uri> {
  const configured = joinRel(folder.uri, configuredFile(folder));
  if ((await exists(configured)) || fileIsExplicit(folder)) return configured;
  const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/.env'), SEARCH_EXCLUDE, 10);
  return found.length === 1 ? found[0] : configured;
}

function lightOf(result: ParseResult | undefined): Light {
  if (!result) return 'green';
  if (result.errors.length > 0) return 'error';
  if (result.groups.some((g) => activeOption(g)?.danger)) return 'red';
  if (result.groups.some((g) => !activeOption(g))) return 'yellow';
  return 'green';
}

function hasContent(ctx: EnvContext): boolean {
  return !!ctx.result && (ctx.result.groups.length > 0 || ctx.result.errors.length > 0);
}

function multi(): boolean {
  return [...contexts.values()].filter(hasContent).length > 1;
}

function ctxFor(key?: unknown): EnvContext | undefined {
  if (typeof key === 'string' && contexts.has(key)) return contexts.get(key);
  const all = [...contexts.values()];
  return all.find(hasContent) ?? all.find((c) => c.text !== undefined) ?? all[0];
}

function ctxForUri(uri: vscode.Uri): EnvContext | undefined {
  return [...contexts.values()].find((c) => sameUri(c.uri, uri));
}

async function refresh(): Promise<void> {
  contexts.clear();
  for (const folder of folders()) {
    const uri = await resolveEnvUri(folder);
    const text = await readText(uri);
    contexts.set(folder.uri.toString(), {
      key: folder.uri.toString(),
      folder,
      uri,
      text,
      result: text === undefined ? undefined : parseEnv(text),
    });
  }

  const views: EnvView[] = [...contexts.values()]
    .map((c) => ({ c, suggestions: suggestionsOf(c) }))
    .filter(({ c, suggestions }) => hasContent(c) || suggestions.length > 0)
    .map(({ c, suggestions }) => ({
      key: c.key,
      name: c.folder.name,
      uri: c.uri?.toString() ?? '',
      fileLabel: c.uri ? relToFolder(c.folder, c.uri) : '',
      result: c.result!,
      light: lightOf(c.result),
      suggestions,
    }));
  tree.setViews(views);
  envAssist?.refresh();
  void vscode.commands.executeCommand(
    'setContext',
    'semaforoEnv.fileExists',
    [...contexts.values()].some((c) => c.text !== undefined),
  );
  updateStatusBar();
  updateDependencyWarnings();
}

/** Variáveis com alternativas ainda fora de grupos, mostradas como sugestão no painel. */
function suggestionsOf(c: EnvContext): Suggestion[] {
  if (c.text === undefined || !c.result || c.result.errors.length > 0) return [];
  try {
    return proposeOrganization(c.text).groups.map((g) => ({ name: g.name, keys: g.keys, options: g.options.map((o) => o.name) }));
  } catch {
    return [];
  }
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refresh(), 150);
}

function allDangers(): { label: string; system: string; group: string; option: string }[] {
  const out: { label: string; system: string; group: string; option: string }[] = [];
  for (const c of contexts.values()) {
    for (const d of activeDangers(c.result)) {
      const prefix = multi() ? `${c.folder.name} › ` : '';
      out.push({ label: `${prefix}${d.group.name}: ${d.option.name}`, system: c.folder.name, group: d.group.name, option: d.option.name });
    }
  }
  return out;
}

function updateStatusBar(): void {
  const list = [...contexts.values()].filter(hasContent);
  if (list.length === 0) {
    status.hide();
    return;
  }
  status.color = undefined;

  const broken = list.filter((c) => c.result!.errors.length > 0);
  if (broken.length > 0) {
    status.text = `$(error) Env: erro em ${broken.map((c) => c.folder.name).join(', ')}`;
    status.tooltip = broken.map((c) => `${c.folder.name}: ${formatError(c.result!.errors[0])}`).join('\n');
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    status.command = 'semaforoEnv.openFile';
    status.show();
    return;
  }

  const lights = list.map((c) => lightOf(c.result));
  const light: Light = lights.includes('red') ? 'red' : lights.includes('yellow') ? 'yellow' : 'green';

  if (list.length === 1) {
    const r = list[0].result!;
    status.text = `$(circle-filled) ${r.groups.map((g) => `${g.name}: ${activeOption(g)?.name ?? '?'}`).join(' | ')}`;
  } else {
    status.text = `$(circle-filled) ${list
      .map((c) => {
        const remote = c.result!.groups.map((g) => activeOption(g)).filter((o) => o?.danger).map((o) => o!.name);
        const odd = c.result!.groups.some((g) => !activeOption(g));
        return `${c.folder.name}${remote.length ? ': ' + [...new Set(remote)].join('/') : odd ? ': ?' : ''}`;
      })
      .join(' · ')}`;
  }

  const hint = {
    green: 'Tudo local.',
    yellow: 'Algum grupo está inconsistente. Escolha uma opção para corrigir.',
    red: 'Atenção: banco ou serviço remoto ativo.',
  }[light];
  const detail = list
    .map((c) => `${c.folder.name}: ${c.result!.groups.map((g) => `${g.name} = ${activeOption(g)?.name ?? '?'}`).join(', ')}`)
    .join('\n');
  status.tooltip = `${NAME}\n${detail}\n${hint}\nClique para trocar.`;
  status.backgroundColor =
    light === 'red'
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : light === 'yellow'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
  if (light === 'green') status.color = new vscode.ThemeColor('testing.iconPassed');
  status.command = 'semaforoEnv.quickSwitch';
  status.show();
}

/** Opções ativas que apontam pra localhost:PORTA de um serviço que está parado. */
function computeDependencyWarnings(onlyCtx?: EnvContext): DependencyWarning[] {
  const out: DependencyWarning[] = [];
  const seen = new Set<string>();
  for (const c of contexts.values()) {
    if (onlyCtx && c !== onlyCtx) continue;
    if (!c.text || !c.result) continue;
    for (const ref of localPortRefs(c.text, c.result)) {
      const svc = services.byPort(ref.port);
      if (!svc || services.isUp(svc)) continue;
      const k = `${c.key}|${ref.group}|${svc.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const where = multi() ? `${c.folder.name} › ${ref.group}` : ref.group;
      out.push({ text: `${where} está em ${ref.option}, mas ${svc.id} está parado`, serviceId: svc.id });
    }
  }
  return out;
}

function updateDependencyWarnings(): void {
  servicesTree.setWarnings(computeDependencyWarnings());
  void vscode.commands.executeCommand('setContext', 'semaforoEnv.hasServices', services.list().length > 0);
}

// ───────────────────────── Troca de perfil ─────────────────────────

async function pickContext(placeHolder: string): Promise<EnvContext | undefined> {
  const list = [...contexts.values()].filter(hasContent);
  if (list.length <= 1) return list[0] ?? ctxFor();
  const picked = await vscode.window.showQuickPick(
    list.map((c) => ({ label: c.folder.name, description: c.uri ? relToFolder(c.folder, c.uri) : '', ctx: c })),
    { placeHolder },
  );
  return picked?.ctx;
}

async function selectOption(groupName?: unknown, optionName?: unknown, key?: unknown): Promise<void> {
  if (typeof groupName !== 'string' || typeof optionName !== 'string') {
    await quickSwitch();
    return;
  }
  if (contexts.size === 0) await refresh();
  const ctx = ctxFor(key);
  if (!ctx?.uri) {
    void vscode.window.showErrorMessage(`${NAME}: abra uma pasta no VS Code primeiro.`);
    return;
  }

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(ctx.uri);
  } catch {
    void vscode.window.showErrorMessage(`${NAME}: não encontrei ${relToFolder(ctx.folder, ctx.uri)}.`);
    return;
  }

  let selection;
  try {
    selection = computeSelection(doc.getText(), groupName, optionName);
  } catch (e) {
    void vscode.window.showErrorMessage(`${NAME}: ${(e as Error).message}`);
    await refresh();
    return;
  }

  if (selection.edits.length === 0) {
    vscode.window.setStatusBarMessage(`${groupName}: ${optionName} já está ativo`, 2500);
    return;
  }

  if (selection.option.danger) {
    const choice = await vscode.window.showWarningMessage(
      `Ativar "${optionName}" em "${groupName}"${multi() ? ` (${ctx.folder.name})` : ''}? Essa opção não é local.`,
      { modal: true },
      'Ativar',
    );
    if (choice !== 'Ativar') return;
  }

  const edit = new vscode.WorkspaceEdit();
  for (const e of selection.edits) edit.replace(ctx.uri, doc.lineAt(e.line).range, e.newText);
  if (!(await vscode.workspace.applyEdit(edit))) {
    void vscode.window.showErrorMessage(`${NAME}: não consegui aplicar a alteração no arquivo.`);
    return;
  }
  await doc.save();
  await refresh();
  await afterSwitch(ctxFor(ctx.key)!, `${groupName}: ${optionName} ativo`);
}

/** Depois de trocar o .env: reinicia quem lê esse .env e avisa sobre dependências paradas. */
async function afterSwitch(ctx: EnvContext, summary: string): Promise<void> {
  const envDir = ctx.uri ? vscode.Uri.joinPath(ctx.uri, '..') : undefined;

  if (envDir && services.hasServiceForEnv(envDir)) {
    const restarted = await services.restartUsingEnv(envDir);
    vscode.window.setStatusBarMessage(
      restarted.length ? `$(sync) ${summary}. Reiniciado: ${restarted.join(', ')}` : `${summary}. O serviço desse .env está parado.`,
      4000,
    );
  } else {
    const mode = restartMode();
    if (mode === 'terminal') {
      await restartFoldersForEnv(envDir, summary);
    } else if (mode !== 'off') {
      if (await workspaceServer.restart()) {
        vscode.window.setStatusBarMessage(`$(sync) ${summary}. Servidor reiniciado.`, 4000);
      } else {
        const choice = await vscode.window.showWarningMessage(
          `${summary}, mas não consegui reiniciar o servidor (${workspaceServer.describe()}).`,
          'Configurar reinício',
        );
        if (choice) await configureRestart(envDir);
      }
    } else if (conf().get<boolean>('showRestartHint', true)) {
      const actions = services.list().length ? ['Configurar serviços'] : ['Reiniciar sozinho da próxima vez', 'Configurar serviços'];
      const choice = await vscode.window.showInformationMessage(`${summary}. Reinicie o servidor para aplicar.`, ...actions);
      if (choice === 'Reiniciar sozinho da próxima vez') await configureRestart(envDir);
      else if (choice === 'Configurar serviços') await configureServices();
    }
  }

  const warnings = computeDependencyWarnings(ctx);
  updateDependencyWarnings();
  for (const w of warnings.slice(0, 2)) {
    const choice = await vscode.window.showWarningMessage(`${NAME}: ${w.text}.`, `Iniciar ${w.serviceId}`);
    if (choice) await services.start(w.serviceId);
  }
}

async function quickSwitch(): Promise<void> {
  await refresh();
  const ctx = await pickContext('Qual sistema?');
  const r = ctx?.result;
  if (!ctx || !r) {
    const choice = await vscode.window.showWarningMessage(`${NAME}: não encontrei o .env deste projeto.`, 'Escolher arquivo .env');
    if (choice) await pickFile();
    return;
  }
  if (r.errors.length > 0) {
    void vscode.window.showErrorMessage(`${NAME}: ${formatError(r.errors[0])}`);
    return;
  }
  if (r.groups.length === 0) {
    const choice = await vscode.window.showWarningMessage(`${NAME}: nenhum grupo encontrado nesse .env.`, 'Organizar automaticamente');
    if (choice) await organize(ctx.key);
    return;
  }

  let group = r.groups[0];
  if (r.groups.length > 1) {
    const picked = await vscode.window.showQuickPick(
      r.groups.map((g) => ({ label: g.name, description: activeOption(g)?.name ?? 'inconsistente', group: g })),
      { placeHolder: 'Qual grupo?' },
    );
    if (!picked) return;
    group = picked.group;
  }

  const current = activeOption(group);
  const picked = await vscode.window.showQuickPick(
    group.options.map((o) => ({
      label: `${o === current ? '$(pass-filled)' : '$(circle-large-outline)'} ${o.name}`,
      description: [o === current ? 'ativo' : '', o.danger ? '$(warning) remoto' : ''].filter(Boolean).join(' · '),
      option: o,
    })),
    { placeHolder: `${group.name}: escolha a opção` },
  );
  if (!picked) return;
  await selectOption(group.name, picked.option.name, ctx.key);
}

async function allLocal(): Promise<void> {
  if (contexts.size === 0) await refresh();
  let changedAny = false;
  for (const ctx of [...contexts.values()]) {
    if (!ctx.uri || !ctx.result || ctx.result.groups.length === 0) continue;
    const doc = await vscode.workspace.openTextDocument(ctx.uri);
    const text = doc.getText();
    const result = parseEnv(text);
    if (result.errors.length > 0) {
      void vscode.window.showErrorMessage(`${NAME} (${ctx.folder.name}): ${formatError(result.errors[0])}`);
      continue;
    }
    const plan = planAllLocal(text, result);
    if (plan.skipped.length > 0) {
      void vscode.window.showWarningMessage(`${NAME}: sem opção local em ${plan.skipped.join(', ')} (${ctx.folder.name}).`);
    }
    if (plan.edits.length === 0) continue;
    const edit = new vscode.WorkspaceEdit();
    for (const e of plan.edits) edit.replace(ctx.uri, doc.lineAt(e.line).range, e.newText);
    if (!(await vscode.workspace.applyEdit(edit))) continue;
    await doc.save();
    changedAny = true;
    await refresh();
    await afterSwitch(ctxFor(ctx.key)!, plan.changed.map((c) => `${c.group}: ${c.to}`).join(', '));
  }
  if (!changedAny) vscode.window.setStatusBarMessage(`${NAME}: já está tudo local`, 2500);
}

// ───────────────────────── Proteções ─────────────────────────

async function guardExecution(e: vscode.TerminalShellExecutionStartEvent): Promise<void> {
  if (!conf().get<boolean>('guard.enabled', true)) return;
  const dangers = allDangers();
  if (dangers.length === 0) return;
  const cmd = e.execution.commandLine.value.trim();
  if (!matchesGuard(cmd, conf().get<string[]>('guard.patterns', DEFAULT_GUARD_PATTERNS))) return;
  if (guardAllowOnce && guardAllowOnce.cmd === cmd && Date.now() < guardAllowOnce.until) {
    guardAllowOnce = undefined;
    return;
  }

  e.terminal.sendText('\x03', false);
  const choice = await vscode.window.showWarningMessage(
    `O Semáforo cancelou "${cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd}".`,
    {
      modal: true,
      detail: `Opção remota ativa: ${dangers.map((d) => d.label).join(', ')}.\nEsse comando pode alterar o banco da equipe.`,
    },
    'Rodar mesmo assim',
    'Voltar tudo pra local',
  );
  if (choice === 'Rodar mesmo assim') {
    guardAllowOnce = { cmd, until: Date.now() + 15000 };
    if (e.terminal.shellIntegration) e.terminal.shellIntegration.executeCommand(cmd);
    else e.terminal.sendText(cmd, true);
  } else if (choice === 'Voltar tudo pra local') {
    await allLocal();
    void vscode.window.showInformationMessage(`${NAME}: tudo local. Pode rodar o comando de novo.`);
  }
}

async function warnOnStartup(): Promise<void> {
  if (!conf().get<boolean>('warnOnStartup', true)) return;
  const dangers = allDangers();
  if (dangers.length === 0) return;
  const choice = await vscode.window.showWarningMessage(
    `${NAME}: o projeto abriu com opção remota ativa (${dangers.map((d) => d.label).join(', ')}).`,
    'Voltar tudo pra local',
    'Manter',
  );
  if (choice === 'Voltar tudo pra local') await allLocal();
}

// ───────────────────────── Organizar .env ─────────────────────────

/** Mostra o antes e depois, pede confirmação e grava o texto inteiro do .env. */
async function confirmReplace(
  doc: vscode.TextDocument,
  newText: string,
  opts: { previewName: string; title: string; message: string; detail: string; done: string },
): Promise<boolean> {
  const id = `${Date.now()}`;
  previews.set(id, newText);
  const previewUri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${opts.previewName}`, query: id });
  await vscode.commands.executeCommand('vscode.diff', doc.uri, previewUri, opts.title, { preview: true });
  const choice = await vscode.window.showInformationMessage(opts.message, { modal: true, detail: opts.detail }, 'Aplicar');
  previews.delete(id);
  if (choice !== 'Aplicar') return false;

  const last = doc.lineAt(doc.lineCount - 1);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(new vscode.Position(0, 0), last.range.end), newText);
  if (!(await vscode.workspace.applyEdit(edit))) return false;
  await doc.save();
  await refresh();
  await vscode.window.showTextDocument(doc);
  vscode.window.setStatusBarMessage(`$(check) ${NAME}: ${opts.done} Ctrl+Z desfaz.`, 4000);
  return true;
}

async function previewAndApply(doc: vscode.TextDocument, proposal: Proposal): Promise<void> {
  const lines = describeProposal(proposal);
  const removed = proposal.removedComments.length
    ? `\n\n${proposal.removedComments.length} comentário(s) que só indicavam o ambiente serão removidos.`
    : '';
  await confirmReplace(doc, proposal.newText, {
    previewName: '.env (organizado)',
    title: '.env ↔ organizado pelo Semáforo',
    message: `Organizar o .env em ${proposal.groups.length} grupo(s)?`,
    detail: `${lines.join('\n')}${removed}\n\nNenhum valor muda: as linhas só são agrupadas. Dá pra desfazer com Ctrl+Z.`,
    done: '.env organizado.',
  });
}

async function organize(arg?: unknown): Promise<void> {
  if (contexts.size === 0) await refresh();
  // Pode vir do nó "Sugestões" da árvore.
  const key = arg && typeof arg === 'object' && 'ctx' in arg ? (arg as { ctx: EnvView }).ctx.key : arg;
  const active = vscode.window.activeTextEditor?.document;
  let ctx = typeof key === 'string' ? ctxFor(key) : active ? ctxForUri(active.uri) : undefined;
  if (!ctx) {
    const list = [...contexts.values()].filter((c) => c.text !== undefined);
    ctx =
      list.length <= 1
        ? list[0]
        : (await vscode.window.showQuickPick(list.map((c) => ({ label: c.folder.name, ctx: c })), { placeHolder: 'Organizar o .env de qual sistema?' }))?.ctx;
  }
  const uri = ctx?.uri ?? (active && /(^|[\\/])\.env[^\\/]*$/.test(active.uri.path) ? active.uri : undefined);
  if (!uri) {
    const choice = await vscode.window.showWarningMessage(`${NAME}: não encontrei o .env.`, 'Escolher arquivo .env');
    if (choice) await pickFile();
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  let proposal: Proposal;
  try {
    proposal = proposeOrganization(doc.getText());
  } catch (e) {
    void vscode.window.showErrorMessage(`${NAME}: ${(e as Error).message}`);
    return;
  }
  if (proposal.groups.length === 0) {
    void vscode.window.showInformationMessage(
      `${NAME}: não encontrei variáveis com alternativas fora dos grupos (a mesma variável ativa e comentada). Se quiser agrupar linhas específicas, selecione-as e use "Criar grupo com as linhas selecionadas".`,
    );
    return;
  }
  await previewAndApply(doc, proposal);
}

async function groupFromSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const lines = new Set<number>();
  for (const sel of editor.selections) {
    const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
    for (let n = sel.start.line; n <= end; n++) lines.add(n);
  }
  let first: Proposal;
  try {
    first = proposeOrganization(doc.getText(), { onlyLines: lines });
  } catch (e) {
    void vscode.window.showErrorMessage(`${NAME}: ${(e as Error).message}`);
    return;
  }
  if (first.groups.length === 0) {
    void vscode.window.showWarningMessage(
      `${NAME}: selecione linhas de variáveis com pelo menos duas alternativas (ex.: a ativa e a comentada), fora de grupos existentes.`,
    );
    return;
  }
  const name = await vscode.window.showInputBox({ prompt: 'Nome do grupo', value: first.groups[0].name });
  if (!name) return;
  await previewAndApply(doc, proposeOrganization(doc.getText(), { onlyLines: lines, groupName: name.trim() }));
}

// ───────────────────────── Editor em tabela ─────────────────────────

function uriArg(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  if (typeof arg !== 'string' || !/^[a-z][a-z0-9+.-]*:/i.test(arg)) return undefined;
  try {
    return vscode.Uri.parse(arg, true);
  } catch {
    return undefined;
  }
}

/** O documento do .env pedido, o do editor ativo ou o do sistema escolhido. */
async function envDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  if (contexts.size === 0) await refresh();
  let target = uri;
  if (!target) {
    const active = vscode.window.activeTextEditor?.document;
    target = active && isEnvDocument(active) ? active.uri : (await pickContext('Em qual .env?'))?.uri;
  }
  if (!target || !(await exists(target))) {
    const choice = await vscode.window.showWarningMessage(`${NAME}: não encontrei o .env.`, 'Escolher arquivo .env');
    if (choice) await pickFile();
    return undefined;
  }
  return vscode.workspace.openTextDocument(target);
}

/** Parse do documento; se tiver erro, avisa e oferece ir até a linha. */
async function parsedOrWarn(doc: vscode.TextDocument): Promise<ParseResult | undefined> {
  const parsed = parseEnv(doc.getText());
  if (parsed.errors.length === 0) return parsed;
  const first = parsed.errors[0];
  const choice = await vscode.window.showErrorMessage(`${NAME}: corrija o .env primeiro. ${formatError(first)}`, 'Ir até a linha');
  if (choice) {
    const editor = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(first.line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
  return undefined;
}

function fileLabelOf(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return path.basename(uri.fsPath);
  const rel = relToFolder(folder, uri);
  return folders().length > 1 ? `${folder.name}/${rel}` : rel;
}

function describeModel(m: GroupModel): string {
  const opts = m.options
    .map((o, i) => `${normalizeName(o.name)}${i === m.active ? ' (ativa)' : ''}${o.danger ? ' (remoto)' : ''}`)
    .join(', ');
  return `Opções: ${opts}\nVariáveis: ${m.keys.join(', ')}`;
}

function sameValues(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

async function applyFromEditor(uri: vscode.Uri, model: GroupModel, originalName: string | undefined): Promise<ApplyOutcome> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const text = doc.getText();
  const errors = validateModel(model, groupRefs(text).filter((g) => g.name !== originalName));
  if (errors.length > 0) return errors;
  let result: ApplyResult;
  try {
    result = applyGroupModel(text, model, originalName);
  } catch (e) {
    return [errorText(e)];
  }
  if (result.text === text) {
    vscode.window.setStatusBarMessage(`${NAME}: nada mudou no .env`, 2500);
    return 'done';
  }
  const name = normalizeName(model.name);
  const extra = [
    result.moved ? `${plural(result.moved, 'linha solta', 'linhas soltas')} dessas variáveis ${result.moved === 1 ? 'entra' : 'entram'} no grupo.` : '',
    result.released.length ? `${result.released.join(', ')} sai do grupo e fica no .env com o valor da opção ativa.` : '',
  ].filter(Boolean);
  const ok = await confirmReplace(doc, result.text, {
    previewName: `.env (${name})`,
    title: `.env ↔ ${name}`,
    message: originalName === undefined ? `Criar o seletor "${name}" no .env?` : `Salvar o grupo "${name}" no .env?`,
    detail: `${describeModel(model)}${extra.length ? '\n\n' + extra.join('\n') : ''}\n\nDá pra desfazer com Ctrl+Z.`,
    done: `seletor "${name}" salvo.`,
  });
  if (!ok) return [];

  // Se o valor ativo mudou, quem lê esse .env reinicia, como numa troca pelo painel.
  const ctx = ctxForUri(doc.uri);
  const keys = [...new Set([...model.keys, ...result.released])];
  if (ctx && !sameValues(activeValues(text, keys), activeValues(result.text, keys))) {
    await afterSwitch(ctx, `${name}: ${normalizeName(model.options[model.active].name)} ativo`);
  }
  return 'done';
}

async function openEditor(doc: vscode.TextDocument, model: GroupModel, originalName: string | undefined, notices: string[]): Promise<void> {
  const uri = doc.uri;
  openGroupEditor(
    extensionUri,
    { model, fileLabel: fileLabelOf(uri), notices, keySuggestions: looseKeys(doc.getText()), isNew: originalName === undefined },
    {
      addKey: async (m, key) => {
        const current = (await vscode.workspace.openTextDocument(uri)).getText();
        const owner = groupRefs(current).find((g) => g.name !== originalName && g.keys.includes(key));
        if (owner) return { error: `${key} já pertence ao grupo "${owner.name}". Cada variável só pode estar em um grupo.` };
        const n = mergeLoose(m, current, [key]);
        return {
          model: m,
          notice: n ? `${plural(n, 'valor', 'valores')} de ${key} que já ${n === 1 ? 'estava' : 'estavam'} no .env ${n === 1 ? 'entrou' : 'entraram'} na tabela.` : undefined,
        };
      },
      apply: (m) => applyFromEditor(uri, m, originalName),
      openFile: () => void vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: false }),
    },
  );
}

/** Abre a tabela de um grupo existente (nó da árvore, CodeLens/hover ou paleta). */
async function editGroup(a?: unknown, b?: unknown): Promise<void> {
  let uri = uriArg(a);
  let name = typeof b === 'string' ? b : undefined;
  const node = a as Node | undefined;
  if (node && typeof node === 'object' && 'type' in node && node.type === 'group') {
    uri = uriArg(node.ctx.uri);
    name = node.group.name;
  }
  const doc = await envDocument(uri);
  if (!doc) return;
  const parsed = await parsedOrWarn(doc);
  if (!parsed) return;
  if (!name) {
    if (parsed.groups.length === 0) {
      const choice = await vscode.window.showInformationMessage(`${NAME}: esse .env ainda não tem seletores.`, 'Montar um em tabela');
      if (choice) await newGroup(doc.uri);
      return;
    }
    name =
      parsed.groups.length === 1
        ? parsed.groups[0].name
        : (await vscode.window.showQuickPick(parsed.groups.map((g) => g.name), { placeHolder: 'Editar qual grupo?' }));
    if (!name) return;
  }
  const g = parsed.groups.find((x) => x.name === name);
  if (!g) {
    void vscode.window.showErrorMessage(`${NAME}: o grupo "${name}" não existe mais nesse .env.`);
    return;
  }
  const text = doc.getText();
  const model = modelFromGroup(text, g);
  const notices: string[] = [];
  const merged = mergeLoose(model, text, model.keys);
  if (merged) {
    notices.push(
      `${plural(merged, 'valor', 'valores')} dessas variáveis ${merged === 1 ? 'estava' : 'estavam'} fora do grupo, solto no .env. ` +
        'Já ' + (merged === 1 ? 'está' : 'estão') + ' na tabela e, ao aplicar, entra' + (merged === 1 ? '' : 'm') + ' no grupo.',
    );
  }
  if (model.active < 0) notices.push('Nenhuma opção está ativa agora (grupo inconsistente). Escolha uma na coluna Ativa.');
  await openEditor(doc, model, g.name, notices);
}

/** Tabela em branco para montar um seletor do zero. */
async function newGroup(a?: unknown): Promise<void> {
  const doc = await envDocument(uriArg(a));
  if (!doc || !(await parsedOrWarn(doc))) return;
  const model: GroupModel = {
    name: '',
    keys: [],
    options: [
      { name: 'local', danger: false, values: {} },
      { name: 'homolog', danger: true, values: {} },
    ],
    active: 0,
  };
  await openEditor(doc, model, undefined, []);
}

/** "Transformar em seletor": a tabela já preenchida com os valores soltos dessa variável. */
async function groupFromKey(a?: unknown, key?: unknown): Promise<void> {
  if (typeof key !== 'string') return;
  const doc = await envDocument(uriArg(a));
  if (!doc) return;
  const parsed = await parsedOrWarn(doc);
  if (!parsed) return;
  const text = doc.getText();
  let keys = [key];
  let name: string | undefined;
  const proposed = proposeOrganization(text).groups.find((g) => g.keys.includes(key));
  if (proposed) {
    // Inclui as variáveis que mudam junto (ex.: DIRECT_URL no mesmo host).
    const lines = splitLines(text);
    keys = [...new Set(proposed.options.flatMap((o) => o.lines).flatMap((n) => parseAssignment(lines[n])?.key ?? []))];
    name = proposed.name;
  }
  const model = modelFromLoose(text, keys, name);
  const taken = new Set(parsed.groups.map((g) => g.name));
  if (taken.has(model.name)) {
    const base = model.name;
    for (let i = 2; taken.has(model.name); i++) model.name = `${base} ${i}`;
  }
  const notices = [
    `Montei a tabela com os ${model.options.length} valores de ${keys.join(' + ')} que já estavam no .env. ` +
      'Confira os nomes das opções e o que é remoto, e clique em Aplicar. Nenhum valor muda: as linhas só passam a ficar organizadas.',
  ];
  await openEditor(doc, model, undefined, notices);
}

/** CodeLens "Trocar": escolhe a opção ativa de um grupo do .env controlado. */
async function switchGroup(a?: unknown, groupName?: unknown): Promise<void> {
  const uri = uriArg(a);
  const ctx = uri ? ctxForUri(uri) : undefined;
  const group = ctx?.result?.groups.find((g) => g.name === groupName);
  if (!ctx || !group) {
    await quickSwitch();
    return;
  }
  const picked = await vscode.window.showQuickPick(
    group.options.map((o) => ({
      label: o.name,
      description: [o.state === 'active' ? 'ativa' : '', o.danger ? 'remoto' : ''].filter(Boolean).join(' · '),
      option: o,
    })),
    { placeHolder: `${group.name}: qual opção ativar?` },
  );
  if (picked) await selectOption(group.name, picked.option.name, ctx.key);
}

// ───────────────────────── Arquivos ─────────────────────────

async function pickFile(): Promise<void> {
  if (folders().length === 0) {
    void vscode.window.showErrorMessage(`${NAME}: abra uma pasta no VS Code primeiro.`);
    return;
  }
  const found = await vscode.workspace.findFiles('**/.env*', SEARCH_EXCLUDE, 100);
  const candidates = found
    .filter((uri) => /^\.env(\..+)?$/.test(uri.path.split('/').pop() ?? ''))
    .filter((uri) => !/\.(example|sample|template|bak)$/.test(uri.path))
    .map((uri) => ({ uri, folder: vscode.workspace.getWorkspaceFolder(uri) }))
    .filter((c): c is { uri: vscode.Uri; folder: vscode.WorkspaceFolder } => !!c.folder)
    .sort((a, b) => a.uri.path.localeCompare(b.uri.path));

  if (candidates.length === 0) {
    void vscode.window.showWarningMessage(`${NAME}: nenhum arquivo .env encontrado.`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((c) => ({
      label: relToFolder(c.folder, c.uri),
      description: folders().length > 1 ? c.folder.name : sameUri(c.uri, ctxFor()?.uri) ? 'atual' : '',
      c,
    })),
    { placeHolder: 'Qual arquivo o Semáforo deve controlar?' },
  );
  if (!picked) return;
  // semaforoEnv.file tem scope "resource": grava na pasta dona do arquivo (numa pasta única, é o mesmo .vscode/settings.json).
  await writeSetting(
    'file',
    relToFolder(picked.c.folder, picked.c.uri),
    vscode.ConfigurationTarget.WorkspaceFolder,
    picked.c.folder.uri,
    `a escolha do arquivo .env de ${picked.c.folder.name}`,
  );
}

async function openFile(line?: unknown, key?: unknown): Promise<void> {
  if (contexts.size === 0) await refresh();
  const ctx = ctxFor(key);
  const uri = ctx?.uri;
  if (!uri || !(await exists(uri))) {
    const choice = await vscode.window.showWarningMessage(`${NAME}: não encontrei o .env.`, 'Escolher arquivo .env');
    if (choice) await pickFile();
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  if (typeof line === 'number' && line >= 0 && line < doc.lineCount) {
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

async function createExample(): Promise<void> {
  const folder = folders()[0];
  if (!folder) return;
  const uri = vscode.Uri.joinPath(folder.uri, '.env.example');
  if (!(await exists(uri))) await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(EXAMPLE_ENV));
  await vscode.window.showTextDocument(uri);
}

// ───────────────────────── Serviços ─────────────────────────

function idFrom(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  const n = arg as SvcNode | undefined;
  if (n?.type === 'service') return n.runtime.id;
  if (n?.type === 'warning') return n.warning.serviceId;
  return undefined;
}

function systemFrom(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  const n = arg as SvcNode | undefined;
  return n?.type === 'system' ? n.system : undefined;
}

async function configureServices(): Promise<void> {
  if (folders().length === 0) return;
  const pkgs = await vscode.workspace.findFiles('**/package.json', SEARCH_EXCLUDE, 60);
  type Item = vscode.QuickPickItem & { def: ServiceDef };
  const items: Item[] = [];
  for (const uri of pkgs) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) continue;
    let pkg: { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri)));
    } catch {
      continue;
    }
    const scripts = pkg.scripts ?? {};
    const best = rankDevScripts(scripts)[0];
    if (!best) continue;
    const dir = vscode.Uri.joinPath(uri, '..');
    const entries = await vscode.workspace.fs.readDirectory(dir);
    const pm = await packageManagerFor(dir, folder);
    const kind = classifyPackage(pkg);
    const envText = entries.some(([n]) => n === '.env') ? await readText(vscode.Uri.joinPath(dir, '.env')) : undefined;
    const cwd = relToFolder(folder, dir);
    const base = cwd ? cwd.split('/').pop()! : folder.name;
    const def: ServiceDef = {
      system: folder.name,
      name: kind ?? base,
      folder: folders().length > 1 ? folder.name : undefined,
      cwd,
      command: scriptCommand(pm, best),
      port: guessPort(kind, pkg, envText),
    };
    items.push({
      label: `${def.system} · ${def.name}`,
      description: `${def.command}${def.port ? `  :${def.port}` : ''}`,
      detail: `${cwd || 'raiz'}${kind ? '' : '  (não identifiquei se é front ou back)'}`,
      picked: !!kind,
      def,
    });
  }
  // Nomes repetidos no mesmo sistema (ex.: dois "back") usam o nome da pasta.
  const count = new Map<string, number>();
  items.forEach((i) => count.set(i.label, (count.get(i.label) ?? 0) + 1));
  for (const i of items) {
    if ((count.get(i.label) ?? 0) > 1 && i.def.cwd) {
      i.def.name = i.def.cwd.split('/').pop()!;
      i.label = `${i.def.system} · ${i.def.name}`;
    }
  }

  // Portas repetidas (ex.: dois Vite na 5173) seguem a próxima livre, como o próprio Vite faz.
  const usedPorts = new Set<number>();
  for (const i of [...items].sort((a, b) => Number(!!b.picked) - Number(!!a.picked))) {
    if (!i.def.port) continue;
    while (usedPorts.has(i.def.port)) i.def.port++;
    usedPorts.add(i.def.port);
    i.description = `${i.def.command}  :${i.def.port}`;
  }

  if (items.length === 0) {
    void vscode.window.showWarningMessage(`${NAME}: não encontrei package.json com scripts neste workspace.`);
    return;
  }
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: 'Marque os serviços que o Semáforo deve gerenciar (dá pra ajustar depois em semaforoEnv.services)',
    matchOnDetail: true,
  });
  if (!picked || picked.length === 0) return;
  const defs = picked.map((p) => {
    const { folder, ...rest } = p.def;
    return folder ? p.def : rest;
  });
  // semaforoEnv.services descreve serviços de todas as pastas (campo "folder"), então vive no nível do workspace.
  if (!(await writeSetting('services', defs, vscode.ConfigurationTarget.Workspace, undefined, 'os serviços detectados'))) return;
  const choice = await vscode.window.showInformationMessage(
    `${NAME}: ${defs.length} serviço(s) configurado(s). Quando você trocar um .env, os serviços que leem esse arquivo reiniciam sozinhos.`,
    'Iniciar todos agora',
  );
  if (choice) await services.startAll();
}

async function createWorkspace(): Promise<void> {
  const base = folders()[0] ? vscode.Uri.joinPath(folders()[0].uri, '..') : undefined;
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: true,
    defaultUri: base,
    openLabel: 'Incluir no ecossistema',
    title: 'Escolha as pastas dos sistemas (ex.: estoque, loja, pagamentos)',
  });
  if (!picked || picked.length === 0) return;
  const parent = vscode.Uri.joinPath(picked[0], '..');
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(parent, 'ecossistema.code-workspace'),
    filters: { 'Workspace do VS Code': ['code-workspace'] },
    saveLabel: 'Criar workspace',
  });
  if (!target) return;
  const dir = path.dirname(target.fsPath);
  const content = {
    folders: picked.map((f) => ({ path: (path.relative(dir, f.fsPath) || '.').split(path.sep).join('/') })),
    settings: {},
  };
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(JSON.stringify(content, null, 2) + '\n'));
  const choice = await vscode.window.showInformationMessage(
    `${NAME}: workspace criado com ${picked.length} pasta(s). Abra e use "Detectar serviços" pra montar o painel.`,
    'Abrir agora',
  );
  if (choice) await vscode.commands.executeCommand('vscode.openFolder', target);
}

// ───────────────────────── Reinício simples ─────────────────────────
// Tudo fica no workspaceState (src/state/restartCommandStore.ts); nada aqui grava em settings.json.

/** Gerenciador pelo lockfile da pasta. Sem lockfile, sobe até a raiz da pasta do workspace (monorepo). */
async function packageManagerFor(dir: vscode.Uri, folder: vscode.WorkspaceFolder): Promise<PackageManager> {
  const root = normalizeFolderPath(folder.uri.fsPath);
  let current = dir;
  for (;;) {
    let names: string[] = [];
    try {
      names = (await vscode.workspace.fs.readDirectory(current)).map(([name]) => name);
    } catch {
      // pasta ilegível: continua subindo
    }
    if (hasLockfile(names)) return detectPackageManager(names);
    const parent = vscode.Uri.joinPath(current, '..');
    if (normalizeFolderPath(current.fsPath) === root || parent.path === current.path) return 'npm';
    current = parent;
  }
}

interface StartCommandItem extends vscode.QuickPickItem {
  command: string;
  /** Pasta absoluta do package.json (vazio no item "Digitar outro comando"). */
  folder: string;
}

/** QuickPick "Qual comando inicia o servidor?". Devolve o comando e a pasta do projeto. */
async function pickStartCommand(prefer?: vscode.Uri): Promise<{ command: string; folder: string } | undefined> {
  const pkgs = (await vscode.workspace.findFiles('**/package.json', SEARCH_EXCLUDE, 30)).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  const items: StartCommandItem[] = [];
  for (const uri of pkgs) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) continue;
    let scripts: Record<string, string>;
    try {
      const raw: unknown = JSON.parse(new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri)));
      scripts = packageScripts(raw);
    } catch {
      continue; // package.json inválido: ignora
    }
    const dir = vscode.Uri.joinPath(uri, '..');
    const pm = await packageManagerFor(dir, folder);
    const saved = restartStore.get(dir.fsPath)?.command;
    for (const name of rankDevScripts(scripts).slice(0, 6)) {
      const command = scriptCommand(pm, name);
      items.push({
        label: command,
        description: [folderLabel(dir.fsPath), command === saved ? 'salvo' : ''].filter(Boolean).join(' · '),
        detail: scripts[name],
        command,
        folder: dir.fsPath,
      });
    }
  }

  // Os projetos da pasta do .env que acabou de mudar aparecem primeiro.
  if (prefer) {
    const key = normalizeFolderPath(prefer.fsPath);
    const rank = (item: StartCommandItem): number => {
      const dir = normalizeFolderPath(item.folder);
      return dir === key ? 0 : dir.startsWith(key + path.sep) ? 1 : 2;
    };
    items.sort((a, b) => rank(a) - rank(b));
  }

  items.push({ label: '$(edit) Digitar outro comando...', command: '', folder: '' });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Qual comando inicia o servidor?',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return undefined;
  if (picked.command) return { command: picked.command, folder: picked.folder };

  const command = (
    await vscode.window.showInputBox({ prompt: 'Comando que inicia o servidor', placeHolder: 'npm run start:dev' })
  )?.trim();
  if (!command) return undefined;
  const preferFolder = prefer ? vscode.workspace.getWorkspaceFolder(prefer) : undefined;
  const base = preferFolder ?? folders()[0];
  if (!base) return undefined;
  const rel = await vscode.window.showInputBox({
    prompt: `Pasta onde rodar, relativa a ${base.name} (vazio = raiz)`,
    placeHolder: 'loja-api',
    value: preferFolder && prefer ? relFsPath(preferFolder, prefer.fsPath) : '',
  });
  if (rel === undefined) return undefined;
  return { command, folder: joinRel(base.uri, rel.trim()).fsPath };
}

/** Escolhe o comando de inicialização e salva para a pasta do projeto escolhido. */
async function chooseStartCommand(prefer?: vscode.Uri): Promise<void> {
  const chosen = await pickStartCommand(prefer);
  if (!chosen) return;
  const previous = restartStore.get(chosen.folder);
  // Outro comando: o terminal que estava sendo acompanhado não serve mais.
  if (previous && previous.command !== chosen.command) dropFolderServer(chosen.folder);
  await restartStore.set(chosen.folder, { command: chosen.command, cwd: chosen.folder });
  await restartStore.setMode('terminal');

  const choice = await vscode.window.showInformationMessage(
    `${NAME}: pronto. Quando o .env de ${folderLabel(chosen.folder)} mudar, o Semáforo reinicia "${chosen.command}".`,
    'Iniciar servidor agora',
  );
  if (choice) await folderServer(chosen.folder).start();
}

/** Modo terminal: reinicia os comandos salvos para a pasta do .env que mudou. */
async function restartFoldersForEnv(envDir: vscode.Uri | undefined, summary: string): Promise<void> {
  const targets = envDir ? restartStore.forEnvDir(envDir.fsPath) : [];
  if (targets.length === 0) {
    const where = envDir ? folderLabel(envDir.fsPath) : 'este projeto';
    const choice = await vscode.window.showWarningMessage(
      `${summary}. Ainda não há comando de inicialização salvo para ${where}.`,
      'Escolher comando',
    );
    if (choice) await chooseStartCommand(envDir);
    return;
  }

  const done: string[] = [];
  const failed: string[] = [];
  for (const t of targets) ((await folderServer(t.folder).restart()) ? done : failed).push(folderLabel(t.cwd));
  if (done.length > 0) vscode.window.setStatusBarMessage(`$(sync) ${summary}. Reiniciado: ${done.join(', ')}`, 4000);
  if (failed.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `${summary}, mas não consegui reiniciar o servidor de ${failed.join(', ')}.`,
      'Configurar reinício',
    );
    if (choice) await configureRestart(envDir);
  }
}

/** Escolhe uma das pastas com comando salvo. Com uma só, devolve direto (a menos que always). */
async function pickSavedCommand(placeHolder: string, always = false): Promise<StoredRestartCommand | undefined> {
  const saved = restartStore.list();
  if (saved.length === 0 || (saved.length === 1 && !always)) return saved[0];
  const picked = await vscode.window.showQuickPick(
    saved.map((entry) => ({ label: folderLabel(entry.cwd), description: entry.command, detail: entry.cwd, entry })),
    { placeHolder },
  );
  return picked?.entry;
}

async function configureRestart(preferDir?: unknown): Promise<void> {
  if (folders().length === 0) return;
  const prefer = preferDir instanceof vscode.Uri ? preferDir : undefined;

  const mode = await vscode.window.showQuickPick(
    [
      {
        label: '$(terminal) Terminal',
        description: 'recomendado',
        detail:
          'Reinicia o terminal onde o servidor está rodando. Se não houver, abre um terminal visível. O comando fica salvo por pasta de projeto.',
        value: 'terminal' as RestartMode,
      },
      { label: '$(tasklist) Task do VS Code', detail: 'Reinicia uma task do tasks.json.', value: 'task' as RestartMode },
      { label: '$(debug-alt) Sessão de debug', detail: 'Reinicia a sessão do F5.', value: 'debug' as RestartMode },
      { label: '$(circle-slash) Desligado', detail: 'Só mostra o lembrete para reiniciar.', value: 'off' as RestartMode },
    ],
    { placeHolder: 'Como o Semáforo deve reiniciar o servidor depois de trocar o .env?' },
  );
  if (!mode) return;

  if (mode.value === 'terminal') {
    await chooseStartCommand(prefer);
    return;
  }
  if (mode.value === 'task') {
    const tasks = await vscode.tasks.fetchTasks();
    const picked = await vscode.window.showQuickPick(
      tasks.map((t) => ({ label: t.name, description: t.source, name: t.name })),
      { placeHolder: 'Qual task inicia o servidor?' },
    );
    if (!picked) return;
    await restartStore.setTask(picked.name);
  }

  await restartStore.setMode(mode.value);
  if (mode.value === 'off') return;
  const choice = await vscode.window.showInformationMessage(
    `${NAME}: pronto. Depois de cada troca, ${workspaceServer.describe()}.`,
    'Iniciar servidor agora',
  );
  if (choice) await workspaceServer.start();
}

async function startServer(): Promise<void> {
  if (services.list().length) {
    await services.startAll();
    return;
  }
  const mode = restartMode();
  if (mode === 'task' || mode === 'debug') {
    if (!(await workspaceServer.start())) await configureRestart();
    return;
  }
  if (mode !== 'terminal' || restartStore.list().length === 0) return configureRestart();
  const entry = await pickSavedCommand('Iniciar o servidor de qual pasta?');
  if (entry && !(await folderServer(entry.folder).start())) await configureRestart(vscode.Uri.file(entry.cwd));
}

async function restartServer(): Promise<void> {
  const mode = restartMode();
  if (mode === 'task' || mode === 'debug') {
    if (await workspaceServer.restart()) vscode.window.setStatusBarMessage('$(sync) Servidor reiniciado', 3000);
    else await configureRestart();
    return;
  }
  if (mode !== 'terminal' || restartStore.list().length === 0) return configureRestart();
  const entry = await pickSavedCommand('Reiniciar o servidor de qual pasta?');
  if (!entry) return;
  if (await folderServer(entry.folder).restart()) {
    vscode.window.setStatusBarMessage(`$(sync) Servidor reiniciado: ${folderLabel(entry.cwd)}`, 3000);
  } else {
    await configureRestart(vscode.Uri.file(entry.cwd));
  }
}

/** Semáforo Env: Redefinir comando de inicialização. */
async function resetRestartCommand(): Promise<void> {
  if (restartStore.list().length === 0) {
    void vscode.window.showInformationMessage(`${NAME}: nenhum comando de inicialização salvo neste workspace.`);
    return;
  }
  const entry = await pickSavedCommand('Redefinir o comando de inicialização de qual pasta?', true);
  if (!entry) return;
  await restartStore.clear(entry.folder);
  dropFolderServer(entry.folder);
  const choice = await vscode.window.showInformationMessage(
    `${NAME}: comando de inicialização de ${folderLabel(entry.cwd)} redefinido ("${entry.command}" não será mais usado).`,
    'Escolher outro comando',
  );
  if (choice) await chooseStartCommand(vscode.Uri.file(entry.cwd));
}

// ───────────────────────── Ativação ─────────────────────────

function setupWatchers(ctx: vscode.ExtensionContext): void {
  watchers.forEach((w) => w.dispose());
  watchers = folders().map((folder) => {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/.env*'));
    w.onDidChange(scheduleRefresh);
    w.onDidCreate(scheduleRefresh);
    w.onDidDelete(scheduleRefresh);
    return w;
  });
  ctx.subscriptions.push(...watchers);
}

export function activate(ctx: vscode.ExtensionContext): void {
  extensionUri = ctx.extensionUri;
  tree = new EnvTreeProvider();
  const assist = registerEnvAssist((uri) => !!ctxForUri(uri));
  envAssist = assist;
  restartStore = new RestartCommandStore(ctx.workspaceState);
  workspaceServer = new ServerManager(workspaceRestartConfig);
  const log = vscode.window.createOutputChannel(NAME, { log: true });
  services = new ServiceManager(serviceDefs, serviceCwd, log);
  servicesTree = new ServicesTreeProvider(services);
  const servicesView = vscode.window.createTreeView('semaforoEnv.services', { treeDataProvider: servicesTree });
  status = vscode.window.createStatusBarItem('semaforoEnv.status', vscode.StatusBarAlignment.Left, 100);
  status.name = NAME;

  const cmd = (id: string, fn: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(id, fn);

  ctx.subscriptions.push(
    log,
    ...assist.disposables,
    tree,
    servicesTree,
    status,
    workspaceServer,
    {
      dispose: () => {
        folderServers.forEach((s) => s.dispose());
        folderServers.clear();
      },
    },
    services,
    vscode.window.createTreeView('semaforoEnv.view', { treeDataProvider: tree }),
    servicesView,
    // Com o painel aberto, confere de tempos em tempos se o que roda nos terminais bate com o painel.
    servicesView.onDidChangeVisibility((e) => services.setPolling(e.visible)),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) void services.reconcile();
    }),
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
      provideTextDocumentContent: (uri) => previews.get(uri.query) ?? '',
    }),
    services.onDidChange(() => {
      servicesTree.refresh();
      updateDependencyWarnings();
    }),

    // Perfis
    cmd('semaforoEnv.selectOption', selectOption),
    cmd('semaforoEnv.quickSwitch', quickSwitch),
    cmd('semaforoEnv.refresh', refresh),
    cmd('semaforoEnv.openFile', openFile),
    cmd('semaforoEnv.pickFile', pickFile),
    cmd('semaforoEnv.createExample', createExample),
    cmd('semaforoEnv.allLocal', allLocal),
    cmd('semaforoEnv.organize', organize),
    cmd('semaforoEnv.groupFromSelection', groupFromSelection),
    cmd('semaforoEnv.editGroup', editGroup),
    cmd('semaforoEnv.newGroup', newGroup),
    cmd('semaforoEnv.groupFromKey', groupFromKey),
    cmd('semaforoEnv.switchGroup', switchGroup),

    // Reinício simples
    cmd('semaforoEnv.configureRestart', configureRestart),
    cmd('semaforoEnv.startServer', startServer),
    cmd('semaforoEnv.restartServer', restartServer),
    cmd('semaforoEnv.resetRestartCommand', resetRestartCommand),

    // Serviços
    cmd('semaforoEnv.configureServices', configureServices),
    cmd('semaforoEnv.createWorkspace', createWorkspace),
    cmd('semaforoEnv.services.startAll', () => services.startAll()),
    cmd('semaforoEnv.services.stopAll', () => services.stopAll()),
    cmd('semaforoEnv.service.start', (a) => idFrom(a) && services.start(idFrom(a)!)),
    cmd('semaforoEnv.service.stop', (a) => idFrom(a) && services.stop(idFrom(a)!)),
    cmd('semaforoEnv.service.restart', (a) => idFrom(a) && services.restart(idFrom(a)!)),
    cmd('semaforoEnv.service.logs', (a) => idFrom(a) && services.showLogs(idFrom(a)!)),
    cmd('semaforoEnv.system.start', (a) => systemFrom(a) && services.startSystem(systemFrom(a)!)),
    cmd('semaforoEnv.system.stop', (a) => systemFrom(a) && services.stopSystem(systemFrom(a)!)),

    // Eventos
    vscode.window.onDidStartTerminalShellExecution((e) => void guardExecution(e)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (ctxForUri(e.document.uri)) scheduleRefresh();
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      if (ctxForUri(d.uri)) scheduleRefresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG)) return;
      if (e.affectsConfiguration(`${CONFIG}.services`)) services.sync();
      setupWatchers(ctx);
      void refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      services.sync();
      setupWatchers(ctx);
      void refresh();
    }),
    { dispose: () => refreshTimer && clearTimeout(refreshTimer) },
  );

  setupWatchers(ctx);
  services.setPolling(servicesView.visible);
  void migrateRestartSettings().catch((e: unknown) => {
    console.warn(`${NAME}: não consegui migrar ${CONFIG}.restart.* para o estado do workspace.`, e);
  });
  void refresh().then(() => warnOnStartup());
}

export function deactivate(): void {
  // Tudo é liberado via ctx.subscriptions.
}
