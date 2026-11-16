import * as vscode from 'vscode';
import {
  EnvGroup,
  ParseResult,
  activeOption,
  computeSelection,
  formatError,
  parseEnv,
} from './parser';
import { EnvTreeProvider } from './treeProvider';
import { EXAMPLE_ENV } from './example';

const CONFIG = 'semaforoEnv';
const NAME = 'Semáforo Env';
const DEFAULT_FILE = '.env';
const SEARCH_EXCLUDE = '**/{node_modules,.git,dist,out,build}/**';

let tree: EnvTreeProvider;
let status: vscode.StatusBarItem;
let watcher: vscode.FileSystemWatcher | undefined;
let lastResult: ParseResult | undefined;
/** Arquivo efetivamente monitorado (configurado ou detectado em subpasta). */
let currentUri: vscode.Uri | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

function workspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

function configuredFile(): string {
  return vscode.workspace.getConfiguration(CONFIG).get<string>('file', DEFAULT_FILE) || DEFAULT_FILE;
}

/** true quando o usuário definiu semaforoEnv.file explicitamente (user ou workspace). */
function fileIsExplicit(): boolean {
  const info = vscode.workspace.getConfiguration(CONFIG).inspect<string>('file');
  return !!(info?.workspaceValue || info?.workspaceFolderValue || info?.globalValue);
}

function uriFromRelative(rel: string): vscode.Uri | undefined {
  const folder = workspaceFolder();
  if (!folder) return undefined;
  return vscode.Uri.joinPath(folder.uri, ...rel.split(/[\\/]+/).filter(Boolean));
}

function sameUri(a: vscode.Uri | undefined, b: vscode.Uri | undefined): boolean {
  return !!a && !!b && a.toString() === b.toString();
}

function relativeLabel(uri: vscode.Uri | undefined): string {
  return uri ? vscode.workspace.asRelativePath(uri, false) : configuredFile();
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve qual arquivo monitorar:
 * 1. o caminho configurado, se existir;
 * 2. se o caminho não foi configurado explicitamente e não existe .env na raiz,
 *    usa o único .env encontrado em subpastas (monorepo).
 */
async function resolveEnvUri(): Promise<vscode.Uri | undefined> {
  const configured = uriFromRelative(configuredFile());
  if (!configured) return undefined;
  if (await exists(configured)) return configured;
  if (fileIsExplicit()) return configured;

  const found = await vscode.workspace.findFiles('**/.env', SEARCH_EXCLUDE, 10);
  return found.length === 1 ? found[0] : configured;
}

async function readEnv(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => sameUri(d.uri, uri));
  if (open) return open.getText();
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return undefined;
  }
}

async function refresh(): Promise<void> {
  currentUri = await resolveEnvUri();
  const text = currentUri ? await readEnv(currentUri) : undefined;
  lastResult = text === undefined ? undefined : parseEnv(text);

  const hasContent = !!lastResult && (lastResult.groups.length > 0 || lastResult.errors.length > 0);
  tree.setResult(hasContent ? lastResult : undefined);
  void vscode.commands.executeCommand('setContext', 'semaforoEnv.fileExists', text !== undefined);
  updateStatusBar();
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refresh(), 150);
}

type Light = 'green' | 'yellow' | 'red';

function lightFor(groups: EnvGroup[]): Light {
  if (groups.some((g) => activeOption(g)?.danger)) return 'red';
  if (groups.some((g) => !activeOption(g))) return 'yellow';
  return 'green';
}

function updateStatusBar(): void {
  const r = lastResult;
  if (!r || (r.groups.length === 0 && r.errors.length === 0)) {
    status.hide();
    return;
  }

  const file = relativeLabel(currentUri);
  status.color = undefined;

  if (r.errors.length > 0) {
    status.text = '$(error) Env: erro no arquivo';
    status.tooltip = `${NAME} · ${file}\n${formatError(r.errors[0])}`;
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    status.command = 'semaforoEnv.openFile';
    status.show();
    return;
  }

  const light = lightFor(r.groups);
  const parts = r.groups.map((g) => `${g.name}: ${activeOption(g)?.name ?? '?'}`);
  const hint = {
    green: 'Tudo local.',
    yellow: 'Algum grupo está inconsistente. Escolha uma opção para corrigir.',
    red: 'Atenção: banco ou serviço remoto ativo.',
  }[light];

  status.text = `$(circle-filled) ${parts.join(' | ')}`;
  status.tooltip = `${NAME} · ${file}\n${hint}\nClique para trocar.`;
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

async function selectOption(groupName?: unknown, optionName?: unknown): Promise<void> {
  if (typeof groupName !== 'string' || typeof optionName !== 'string') {
    await quickSwitch();
    return;
  }
  if (!currentUri) await refresh();
  const uri = currentUri;
  if (!uri) {
    void vscode.window.showErrorMessage(`${NAME}: abra uma pasta no VS Code primeiro.`);
    return;
  }

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    void vscode.window.showErrorMessage(`${NAME}: não encontrei ${relativeLabel(uri)}.`);
    return;
  }

  let selection;
  try {
    // Usa o conteúdo em memória: respeita alterações ainda não salvas.
    selection = computeSelection(doc.getText(), groupName, optionName);
  } catch (e) {
    void vscode.window.showErrorMessage(`${NAME}: ${(e as Error).message}`);
    await refresh();
    return;
  }

  if (selection.edits.length === 0) {
    void vscode.window.setStatusBarMessage(`${groupName}: ${optionName} já está ativo`, 2500);
    return;
  }

  if (selection.option.danger) {
    const choice = await vscode.window.showWarningMessage(
      `Ativar "${optionName}" em "${groupName}"? Essa opção não é local.`,
      { modal: true },
      'Ativar',
    );
    if (choice !== 'Ativar') return;
  }

  const edit = new vscode.WorkspaceEdit();
  for (const e of selection.edits) {
    edit.replace(uri, doc.lineAt(e.line).range, e.newText);
  }
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    void vscode.window.showErrorMessage(`${NAME}: não consegui aplicar a alteração no arquivo.`);
    return;
  }
  await doc.save();
  await refresh();

  if (vscode.workspace.getConfiguration(CONFIG).get<boolean>('showRestartHint', true)) {
    void vscode.window.showInformationMessage(
      `${groupName}: ${optionName} ativo. Reinicie o servidor para aplicar.`,
    );
  }
}

async function quickSwitch(): Promise<void> {
  await refresh();
  const r = lastResult;
  if (!r) {
    const choice = await vscode.window.showWarningMessage(
      `${NAME}: não encontrei ${relativeLabel(currentUri)}.`,
      'Escolher arquivo .env',
    );
    if (choice) await pickFile();
    return;
  }
  if (r.errors.length > 0) {
    void vscode.window.showErrorMessage(`${NAME}: ${formatError(r.errors[0])}`);
    return;
  }
  if (r.groups.length === 0) {
    void vscode.window.showWarningMessage(
      `${NAME}: nenhum grupo encontrado. Marque o .env com # @group, # @option e # @end.`,
    );
    return;
  }

  let group = r.groups[0];
  if (r.groups.length > 1) {
    const picked = await vscode.window.showQuickPick(
      r.groups.map((g) => ({
        label: g.name,
        description: activeOption(g)?.name ?? 'inconsistente',
        group: g,
      })),
      { placeHolder: 'Qual grupo?' },
    );
    if (!picked) return;
    group = picked.group;
  }

  const current = activeOption(group);
  const picked = await vscode.window.showQuickPick(
    group.options.map((o) => ({
      label: `${o === current ? '$(pass-filled)' : '$(circle-large-outline)'} ${o.name}`,
      description: [o === current ? 'ativo' : '', o.danger ? '$(warning) remoto' : '']
        .filter(Boolean)
        .join(' · '),
      option: o,
    })),
    { placeHolder: `${group.name}: escolha a opção` },
  );
  if (!picked) return;
  await selectOption(group.name, picked.option.name);
}

async function pickFile(): Promise<void> {
  const folder = workspaceFolder();
  if (!folder) {
    void vscode.window.showErrorMessage(`${NAME}: abra uma pasta no VS Code primeiro.`);
    return;
  }
  const found = await vscode.workspace.findFiles('**/.env*', SEARCH_EXCLUDE, 50);
  const candidates = found
    .map((uri) => ({ uri, rel: vscode.workspace.asRelativePath(uri, false) }))
    .filter(({ uri }) => /^\.env(\..+)?$/.test(uri.path.split('/').pop() ?? ''))
    .filter(({ rel }) => !/\.(example|sample|template|bak)$/.test(rel))
    .sort((a, b) => a.rel.localeCompare(b.rel));

  if (candidates.length === 0) {
    void vscode.window.showWarningMessage(`${NAME}: nenhum arquivo .env encontrado neste projeto.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((c) => ({
      label: c.rel,
      description: sameUri(c.uri, currentUri) ? 'atual' : '',
      rel: c.rel,
    })),
    { placeHolder: 'Qual arquivo o Semáforo deve controlar?' },
  );
  if (!picked) return;

  await vscode.workspace
    .getConfiguration(CONFIG)
    .update('file', picked.rel, vscode.ConfigurationTarget.Workspace);
  // onDidChangeConfiguration cuida do watcher e do refresh.
}

async function openFile(line?: unknown): Promise<void> {
  if (!currentUri) await refresh();
  const uri = currentUri;
  if (!uri) return;
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    if (typeof line === 'number' && line >= 0 && line < doc.lineCount) {
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  } catch {
    const choice = await vscode.window.showWarningMessage(
      `${NAME}: não encontrei ${relativeLabel(uri)}.`,
      'Escolher arquivo .env',
    );
    if (choice) await pickFile();
  }
}

async function createExample(): Promise<void> {
  const folder = workspaceFolder();
  if (!folder) return;
  const uri = vscode.Uri.joinPath(folder.uri, '.env.example');
  if (!(await exists(uri))) {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(EXAMPLE_ENV));
  }
  await vscode.window.showTextDocument(uri);
}

function setupWatcher(ctx: vscode.ExtensionContext): void {
  watcher?.dispose();
  const folder = workspaceFolder();
  if (!folder) return;
  // Observa qualquer .env: cobre o arquivo configurado e a detecção em subpastas.
  watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/.env*'));
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
  ctx.subscriptions.push(watcher);
}

export function activate(ctx: vscode.ExtensionContext): void {
  tree = new EnvTreeProvider();
  status = vscode.window.createStatusBarItem('semaforoEnv.status', vscode.StatusBarAlignment.Left, 100);
  status.name = NAME;

  ctx.subscriptions.push(
    tree,
    status,
    vscode.window.createTreeView('semaforoEnv.view', { treeDataProvider: tree }),
    vscode.commands.registerCommand('semaforoEnv.selectOption', selectOption),
    vscode.commands.registerCommand('semaforoEnv.quickSwitch', quickSwitch),
    vscode.commands.registerCommand('semaforoEnv.refresh', refresh),
    vscode.commands.registerCommand('semaforoEnv.openFile', openFile),
    vscode.commands.registerCommand('semaforoEnv.pickFile', pickFile),
    vscode.commands.registerCommand('semaforoEnv.createExample', createExample),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (sameUri(e.document.uri, currentUri)) scheduleRefresh();
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      if (sameUri(d.uri, currentUri)) scheduleRefresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG)) {
        setupWatcher(ctx);
        void refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      setupWatcher(ctx);
      void refresh();
    }),
    { dispose: () => refreshTimer && clearTimeout(refreshTimer) },
  );

  setupWatcher(ctx);
  void refresh();
}

export function deactivate(): void {
  // Tudo é liberado via ctx.subscriptions.
}
