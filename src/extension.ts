import * as vscode from 'vscode';
import {
  ParseResult,
  activeOption,
  computeSelection,
  formatError,
  parseEnv,
} from './parser';
import { EnvTreeProvider } from './treeProvider';
import { EXAMPLE_ENV } from './example';

const CONFIG = 'envProfiles';

let tree: EnvTreeProvider;
let status: vscode.StatusBarItem;
let watcher: vscode.FileSystemWatcher | undefined;
let lastResult: ParseResult | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function configuredFile(): string {
  return vscode.workspace.getConfiguration(CONFIG).get<string>('file', '.env') || '.env';
}

function envUri(): vscode.Uri | undefined {
  const root = workspaceRoot();
  if (!root) return undefined;
  return vscode.Uri.joinPath(root, ...configuredFile().split(/[\\/]+/).filter(Boolean));
}

async function readEnv(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return undefined;
  }
}

async function refresh(): Promise<void> {
  const uri = envUri();
  const text = uri ? await readEnv(uri) : undefined;
  lastResult = text === undefined ? undefined : parseEnv(text);

  const hasContent = !!lastResult && (lastResult.groups.length > 0 || lastResult.errors.length > 0);
  tree.setResult(hasContent ? lastResult : undefined);
  void vscode.commands.executeCommand('setContext', 'envProfiles.fileExists', text !== undefined);
  updateStatusBar();
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refresh(), 150);
}

function updateStatusBar(): void {
  const r = lastResult;
  if (!r || (r.groups.length === 0 && r.errors.length === 0)) {
    status.hide();
    return;
  }

  const file = configuredFile();
  if (r.errors.length > 0) {
    status.text = '$(error) Env: erro no arquivo';
    status.tooltip = `${file}\n${formatError(r.errors[0])}`;
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    status.command = 'envProfiles.openFile';
    status.show();
    return;
  }

  let danger = false;
  const parts = r.groups.map((g) => {
    const active = activeOption(g);
    if (active?.danger) danger = true;
    return `${g.name}: ${active ? active.name : '?'}`;
  });

  status.text = `$(database) ${parts.join(' | ')}`;
  status.tooltip = `Env Profiles · ${file}\nClique para trocar${danger ? '\nAtenção: banco remoto ativo' : ''}`;
  status.backgroundColor = danger
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : undefined;
  status.command = 'envProfiles.quickSwitch';
  status.show();
}

async function selectOption(groupName?: string, optionName?: string): Promise<void> {
  if (typeof groupName !== 'string' || typeof optionName !== 'string') {
    await quickSwitch();
    return;
  }
  const uri = envUri();
  if (!uri) {
    void vscode.window.showErrorMessage('Env Profiles: abra uma pasta no VS Code primeiro.');
    return;
  }

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    void vscode.window.showErrorMessage(`Env Profiles: não encontrei ${configuredFile()}.`);
    return;
  }

  let selection;
  try {
    // Usa o conteúdo em memória: respeita alterações ainda não salvas.
    selection = computeSelection(doc.getText(), groupName, optionName);
  } catch (e) {
    void vscode.window.showErrorMessage(`Env Profiles: ${(e as Error).message}`);
    await refresh();
    return;
  }

  if (selection.edits.length === 0) {
    void vscode.window.setStatusBarMessage(`${groupName}: ${optionName} já está ativo`, 2500);
    return;
  }

  if (selection.option.danger) {
    const choice = await vscode.window.showWarningMessage(
      `Ativar "${optionName}" em "${groupName}"? Esse banco não é local.`,
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
    void vscode.window.showErrorMessage('Env Profiles: não consegui aplicar a alteração no arquivo.');
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
    void vscode.window.showWarningMessage(`Env Profiles: não encontrei ${configuredFile()}.`);
    return;
  }
  if (r.errors.length > 0) {
    void vscode.window.showErrorMessage(`Env Profiles: ${formatError(r.errors[0])}`);
    return;
  }
  if (r.groups.length === 0) {
    void vscode.window.showWarningMessage(
      'Env Profiles: nenhum grupo encontrado. Marque o .env com # @group, # @option e # @end.',
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

async function openFile(line?: number): Promise<void> {
  const uri = envUri();
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
    void vscode.window.showWarningMessage(`Env Profiles: não encontrei ${configuredFile()}.`);
  }
}

async function createExample(): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  const uri = vscode.Uri.joinPath(root, '.env.example');
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(EXAMPLE_ENV));
  }
  await vscode.window.showTextDocument(uri);
}

function setupWatcher(ctx: vscode.ExtensionContext): void {
  watcher?.dispose();
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) return;
  watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, configuredFile().replace(/\\/g, '/')),
  );
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
  ctx.subscriptions.push(watcher);
}

export function activate(ctx: vscode.ExtensionContext): void {
  tree = new EnvTreeProvider();
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  ctx.subscriptions.push(
    tree,
    status,
    vscode.window.createTreeView('envProfiles.view', { treeDataProvider: tree }),
    vscode.commands.registerCommand('envProfiles.selectOption', selectOption),
    vscode.commands.registerCommand('envProfiles.quickSwitch', quickSwitch),
    vscode.commands.registerCommand('envProfiles.refresh', refresh),
    vscode.commands.registerCommand('envProfiles.openFile', openFile),
    vscode.commands.registerCommand('envProfiles.createExample', createExample),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === envUri()?.toString()) scheduleRefresh();
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      if (d.uri.toString() === envUri()?.toString()) scheduleRefresh();
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
