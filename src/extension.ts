import * as vscode from 'vscode';
import * as path from 'path';
import { ParseResult, activeOption, computeSelection, formatError, parseEnv } from './parser';
import { EnvTreeProvider, EnvView, Light } from './treeProvider';
import { EXAMPLE_ENV } from './example';
import {
  DEFAULT_GUARD_PATTERNS,
  ServiceDef,
  activeDangers,
  classifyPackage,
  detectPackageManager,
  guessPort,
  localPortRefs,
  matchesGuard,
  normalizeServices,
  planAllLocal,
  rankDevScripts,
  scriptCommand,
} from './logic';
import { Proposal, describeProposal, proposeOrganization } from './organize';
import { RestartConfig, RestartMode, ServerManager } from './server';
import { ServiceManager } from './services';
import { DependencyWarning, ServicesTreeProvider, SvcNode } from './servicesTree';

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
let server: ServerManager;
let services: ServiceManager;
let watchers: vscode.FileSystemWatcher[] = [];
const contexts = new Map<string, EnvContext>();
const previews = new Map<string, string>();
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let guardAllowOnce: { cmd: string; until: number } | undefined;

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

function restartConfig(): RestartConfig {
  const c = conf();
  return {
    mode: c.get<RestartMode>('restart.mode', 'off'),
    command: (c.get<string>('restart.command', '') || '').trim(),
    cwd: (c.get<string>('restart.cwd', '') || '').trim(),
    task: (c.get<string>('restart.task', '') || '').trim(),
  };
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

  const views: EnvView[] = [...contexts.values()].filter(hasContent).map((c) => ({
    key: c.key,
    name: c.folder.name,
    fileLabel: c.uri ? relToFolder(c.folder, c.uri) : '',
    result: c.result!,
    light: lightOf(c.result),
  }));
  tree.setViews(views);
  void vscode.commands.executeCommand(
    'setContext',
    'semaforoEnv.fileExists',
    [...contexts.values()].some((c) => c.text !== undefined),
  );
  updateStatusBar();
  updateDependencyWarnings();
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
    const cfg = restartConfig();
    if (cfg.mode !== 'off') {
      if (await server.restart()) {
        vscode.window.setStatusBarMessage(`$(sync) ${summary}. Servidor reiniciado.`, 4000);
      } else {
        const choice = await vscode.window.showWarningMessage(
          `${summary}, mas não consegui reiniciar o servidor (${server.describe()}).`,
          'Configurar reinício',
        );
        if (choice) await configureRestart();
      }
    } else if (conf().get<boolean>('showRestartHint', true)) {
      const actions = services.list().length ? ['Configurar serviços'] : ['Reiniciar sozinho da próxima vez', 'Configurar serviços'];
      const choice = await vscode.window.showInformationMessage(`${summary}. Reinicie o servidor para aplicar.`, ...actions);
      if (choice === 'Reiniciar sozinho da próxima vez') await configureRestart();
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

async function previewAndApply(doc: vscode.TextDocument, proposal: Proposal): Promise<void> {
  const id = `${Date.now()}`;
  previews.set(id, proposal.newText);
  const previewUri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: '/.env (organizado)', query: id });
  await vscode.commands.executeCommand('vscode.diff', doc.uri, previewUri, '.env ↔ organizado pelo Semáforo', { preview: true });

  const lines = describeProposal(proposal);
  const removed = proposal.removedComments.length
    ? `\n\n${proposal.removedComments.length} comentário(s) que só indicavam o ambiente serão removidos.`
    : '';
  const choice = await vscode.window.showInformationMessage(
    `Organizar o .env em ${proposal.groups.length} grupo(s)?`,
    {
      modal: true,
      detail: `${lines.join('\n')}${removed}\n\nNenhum valor muda: as linhas só são agrupadas. Dá pra desfazer com Ctrl+Z.`,
    },
    'Aplicar',
  );
  previews.delete(id);
  if (choice !== 'Aplicar') return;

  const last = doc.lineAt(doc.lineCount - 1);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(new vscode.Position(0, 0), last.range.end), proposal.newText);
  if (!(await vscode.workspace.applyEdit(edit))) return;
  await doc.save();
  await refresh();
  await vscode.window.showTextDocument(doc);
  vscode.window.setStatusBarMessage(`$(check) ${NAME}: .env organizado. Ctrl+Z desfaz.`, 4000);
}

async function organize(key?: unknown): Promise<void> {
  if (contexts.size === 0) await refresh();
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
  const target = folders().length > 1 ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
  await conf(picked.c.folder.uri).update('file', relToFolder(picked.c.folder, picked.c.uri), target);
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
    const pm = detectPackageManager(entries.map(([n]) => n));
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
  await conf().update('services', defs, vscode.ConfigurationTarget.Workspace);
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
    title: 'Escolha as pastas dos sistemas (ex.: controle, sgc, oraculo)',
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

// ───────────────────────── Reinício simples (modo v0.3) ─────────────────────────

async function configureRestart(): Promise<void> {
  const folder = folders()[0];
  if (!folder) return;
  const cfg = conf();
  const target = vscode.ConfigurationTarget.Workspace;

  const mode = await vscode.window.showQuickPick(
    [
      {
        label: '$(terminal) Terminal',
        description: 'recomendado',
        detail: 'Reinicia o terminal onde o servidor está rodando. Se não houver, abre um terminal visível.',
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
    const pkgs = await vscode.workspace.findFiles('**/package.json', SEARCH_EXCLUDE, 30);
    const items: { label: string; description: string; detail?: string; command: string; cwd: string }[] = [];
    for (const uri of pkgs) {
      try {
        const json = JSON.parse(new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri)));
        const scripts: Record<string, string> = json.scripts ?? {};
        const dir = vscode.Uri.joinPath(uri, '..');
        const entries = await vscode.workspace.fs.readDirectory(dir);
        const pm = detectPackageManager(entries.map(([name]) => name));
        const cwd = relToFolder(folder, dir);
        for (const name of rankDevScripts(scripts).slice(0, 6)) {
          items.push({ label: scriptCommand(pm, name), description: cwd || 'raiz', detail: scripts[name], command: scriptCommand(pm, name), cwd });
        }
      } catch {
        // package.json inválido: ignora
      }
    }
    items.push({ label: '$(edit) Digitar outro comando...', description: '', command: '', cwd: '' });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Qual comando inicia o servidor?', matchOnDetail: true });
    if (!picked) return;
    let { command, cwd } = picked;
    if (!command) {
      command = (await vscode.window.showInputBox({ prompt: 'Comando que inicia o servidor', placeHolder: 'npm run start:dev' })) ?? '';
      if (!command) return;
      cwd = (await vscode.window.showInputBox({ prompt: 'Pasta onde rodar (relativa ao projeto, vazio = raiz)', placeHolder: 'sgc-api' })) ?? '';
    }
    await cfg.update('restart.command', command, target);
    await cfg.update('restart.cwd', cwd, target);
  } else if (mode.value === 'task') {
    const tasks = await vscode.tasks.fetchTasks();
    const picked = await vscode.window.showQuickPick(
      tasks.map((t) => ({ label: t.name, description: t.source, name: t.name })),
      { placeHolder: 'Qual task inicia o servidor?' },
    );
    if (!picked) return;
    await cfg.update('restart.task', picked.name, target);
  }

  await cfg.update('restart.mode', mode.value, target);
  if (mode.value === 'off') return;
  const choice = await vscode.window.showInformationMessage(`${NAME}: pronto. Depois de cada troca, ${server.describe()}.`, 'Iniciar servidor agora');
  if (choice) await server.start();
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
  tree = new EnvTreeProvider();
  server = new ServerManager(restartConfig, () => folders()[0]?.uri);
  services = new ServiceManager(serviceDefs, serviceCwd);
  servicesTree = new ServicesTreeProvider(services);
  status = vscode.window.createStatusBarItem('semaforoEnv.status', vscode.StatusBarAlignment.Left, 100);
  status.name = NAME;

  const cmd = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);

  ctx.subscriptions.push(
    tree,
    servicesTree,
    status,
    server,
    services,
    vscode.window.createTreeView('semaforoEnv.view', { treeDataProvider: tree }),
    vscode.window.createTreeView('semaforoEnv.services', { treeDataProvider: servicesTree }),
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

    // Reinício simples
    cmd('semaforoEnv.configureRestart', configureRestart),
    cmd('semaforoEnv.startServer', async () => {
      if (services.list().length) return services.startAll();
      if (restartConfig().mode === 'off') return configureRestart();
      if (!(await server.start())) await configureRestart();
    }),
    cmd('semaforoEnv.restartServer', async () => {
      if (restartConfig().mode === 'off') return configureRestart();
      if (await server.restart()) vscode.window.setStatusBarMessage('$(sync) Servidor reiniciado', 3000);
      else await configureRestart();
    }),

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
  void refresh().then(() => warnOnStartup());
}

export function deactivate(): void {
  // Tudo é liberado via ctx.subscriptions.
}
