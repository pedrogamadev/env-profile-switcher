import * as vscode from 'vscode';
import { GroupModel, OptionModel, maskValue } from './groupModel';

/** O que o editor em tabela recebe ao abrir. */
export interface EditorInit {
  model: GroupModel;
  /** Arquivo editado, para o cabeçalho (ex.: loja-api/.env). */
  fileLabel: string;
  /** Avisos mostrados no topo (ex.: valores soltos que entraram na tabela). */
  notices: string[];
  /** Variáveis soltas do .env, sugeridas ao adicionar coluna. */
  keySuggestions: string[];
  isNew: boolean;
}

export type AddKeyResult = { model: GroupModel; notice?: string } | { error: string };
/** "done" fecha o editor; lista vazia = o usuário cancelou a confirmação; com itens = erros. */
export type ApplyOutcome = 'done' | string[];

export interface EditorHost {
  addKey(model: GroupModel, key: string): Promise<AddKeyResult>;
  apply(model: GroupModel): Promise<ApplyOutcome>;
  openFile(): void;
}

type FromWebview =
  | { type: 'ready' }
  | { type: 'addKey'; key: unknown; model: unknown }
  | { type: 'apply'; model: unknown }
  | { type: 'openFile' }
  | { type: 'cancel' };

let current: vscode.WebviewPanel | undefined;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function record(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
}

/** Confere o formato do que veio do webview antes de usar. */
function sanitize(raw: unknown): GroupModel | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.keys) || !Array.isArray(r.options)) return undefined;
  const options: OptionModel[] = r.options
    .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
    .map((o) => ({ name: str(o.name), danger: o.danger === true, values: record(o.values), origin: record(o.origin) }));
  return {
    name: str(r.name),
    keys: r.keys.filter((k): k is string => typeof k === 'string'),
    options,
    active: typeof r.active === 'number' && Number.isInteger(r.active) ? r.active : -1,
  };
}

function nonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function html(webview: vscode.Webview, media: vscode.Uri): string {
  const n = nonce();
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'groupEditor.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'groupEditor.js'));
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Semáforo Env</title>
</head>
<body>
<main>
  <header>
    <label class="group-name">Nome do grupo <input id="name" type="text" placeholder="Banco principal" autocomplete="off"></label>
    <span id="file" class="muted"></span>
  </header>
  <p class="hint">Cada <strong>linha</strong> é uma opção. Cada <strong>coluna</strong> é uma variável que o sistema lê.
  Só a opção <strong>ativa</strong> fica descomentada no .env; as outras ficam guardadas como comentário. Clique num valor para editar.</p>
  <div id="notices" aria-live="polite"></div>
  <div class="table-wrap"><table id="grid"></table></div>
  <div class="toolbar">
    <button id="addOption" class="secondary">+ Opção</button>
    <span class="add-key">
      <input id="newKey" type="text" list="keyList" placeholder="DATABASE_URL" autocomplete="off" aria-label="Nome da variável">
      <datalist id="keyList"></datalist>
      <button id="addKey" class="secondary">+ Variável</button>
    </span>
    <label class="toggle"><input id="show" type="checkbox"> Mostrar valores completos</label>
  </div>
  <p id="keyError" class="field-error" hidden></p>
  <ul id="errors" class="errors" aria-live="assertive" hidden></ul>
  <footer>
    <button id="openFile" class="secondary">Ver no .env</button>
    <span class="spacer"></span>
    <button id="cancel" class="secondary">Cancelar</button>
    <button id="apply">Aplicar</button>
  </footer>
</main>
<script nonce="${n}">window.maskValue = ${maskValue.toString()};</script>
<script nonce="${n}" src="${js}"></script>
</body>
</html>`;
}

/** Abre (ou substitui) o editor em tabela de um grupo. */
export function openGroupEditor(extensionUri: vscode.Uri, init: EditorInit, host: EditorHost): void {
  current?.dispose();
  const media = vscode.Uri.joinPath(extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel(
    'semaforoEnv.groupEditor',
    `Semáforo · ${init.model.name || 'novo grupo'}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
  );
  current = panel;
  panel.iconPath = vscode.Uri.joinPath(media, 'activitybar.svg');
  const send = (msg: unknown) => void panel.webview.postMessage(msg);

  const sub = panel.webview.onDidReceiveMessage(async (msg: FromWebview) => {
    switch (msg?.type) {
      case 'ready':
        send({ type: 'init', ...init });
        return;
      case 'addKey': {
        const model = sanitize(msg.model);
        const key = str(msg.key).trim();
        if (!model || !key) return;
        let r: AddKeyResult;
        try {
          r = await host.addKey(model, key);
        } catch (e) {
          r = { error: e instanceof Error ? e.message : String(e) };
        }
        if ('error' in r) send({ type: 'keyError', error: r.error });
        else send({ type: 'model', model: r.model, notice: r.notice });
        return;
      }
      case 'apply': {
        const model = sanitize(msg.model);
        if (!model) return;
        let outcome: ApplyOutcome;
        try {
          outcome = await host.apply(model);
        } catch (e) {
          outcome = [e instanceof Error ? e.message : String(e)];
        }
        if (outcome === 'done') panel.dispose();
        else send({ type: 'errors', errors: outcome });
        return;
      }
      case 'openFile':
        host.openFile();
        return;
      case 'cancel':
        panel.dispose();
        return;
    }
  });
  panel.onDidDispose(() => {
    sub.dispose();
    if (current === panel) current = undefined;
  });
  panel.webview.html = html(panel.webview, media);
}
