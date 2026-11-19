import * as vscode from 'vscode';
import * as path from 'path';
import { activeOption, parseEnv, splitLines } from './parser';
import { proposeOrganization } from './organize';
import { groupTableMarkdown, modelFromGroup } from './groupModel';

/**
 * O .env explica a si mesmo: links clicáveis acima das linhas (CodeLens), hover nos marcadores
 * com a tabela do grupo, marcadores esmaecidos e "@danger" em vermelho.
 */

const MARKER_RE = /^\s*#\s*@(group|option|end)\b/;

/** .env, .env.local, .env.example... (não pega .envrc). */
export function isEnvDocument(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file' && /^\.env(\..+)?$/.test(path.basename(doc.uri.fsPath));
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()<>#+!|~]/g, (c) => '\\' + c);
}

function commandLink(label: string, command: string, args: unknown[]): string {
  return `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
}

class EnvLens implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly controlled: (uri: vscode.Uri) => boolean) {}

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!isEnvDocument(doc)) return [];
    const text = doc.getText();
    const parsed = parseEnv(text);
    if (parsed.errors.length > 0) return [];
    const uri = doc.uri.toString();
    const at = (line: number) => new vscode.Range(line, 0, line, 0);
    const lenses: vscode.CodeLens[] = [];

    for (const g of parsed.groups) {
      if (this.controlled(doc.uri)) {
        const active = activeOption(g);
        lenses.push(
          new vscode.CodeLens(at(g.startLine), {
            title: `$(arrow-swap) ${active ? `ativa: ${active.name}` : 'nenhuma opção ativa'} · Trocar`,
            tooltip: 'Escolher qual opção deste grupo fica ativa',
            command: 'semaforoEnv.switchGroup',
            arguments: [uri, g.name],
          }),
        );
      }
      lenses.push(
        new vscode.CodeLens(at(g.startLine), {
          title: '$(table) Editar em tabela',
          tooltip: 'Opções nas linhas, variáveis nas colunas',
          command: 'semaforoEnv.editGroup',
          arguments: [uri, g.name],
        }),
      );
    }

    let groups;
    try {
      groups = proposeOrganization(text).groups;
    } catch {
      return lenses;
    }
    for (const pg of groups) {
      const first = Math.min(...pg.options.flatMap((o) => o.lines));
      lenses.push(
        new vscode.CodeLens(at(first), {
          title: `$(lightbulb) ${pg.keys.join(' + ')} tem ${pg.options.length} valores (${pg.options.map((o) => o.name).join(', ')}) · Transformar em seletor`,
          tooltip: 'Abre a tabela para revisar os nomes e o que é remoto antes de gravar os marcadores',
          command: 'semaforoEnv.groupFromKey',
          arguments: [uri, pg.keys[0]],
        }),
      );
    }
    if (groups.length >= 2) {
      lenses.push(
        new vscode.CodeLens(at(0), {
          title: `$(wand) Semáforo: transformar as ${groups.length} variáveis com alternativas de uma vez`,
          command: 'semaforoEnv.organize',
          arguments: [],
        }),
      );
    }
    return lenses;
  }
}

const EXPLAIN: Record<string, string> = {
  group:
    '`# @group` abre um **seletor** do Semáforo. Cada `# @option` abaixo é uma alternativa, e só a opção ativa fica descomentada.',
  option:
    '`# @option` abre uma **opção**: as linhas abaixo dela, até a próxima opção, são os valores dessa alternativa. ' +
    '`@danger` marca a opção como remota (pede confirmação e deixa o semáforo vermelho).',
  end: '`# @end` fecha o seletor.',
};

class EnvHover implements vscode.HoverProvider {
  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    if (!isEnvDocument(doc)) return undefined;
    const kind = MARKER_RE.exec(doc.lineAt(pos.line).text)?.[1];
    if (!kind) return undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['semaforoEnv.editGroup'] };
    md.appendMarkdown(EXPLAIN[kind] + '\n\n');
    const text = doc.getText();
    const parsed = parseEnv(text);
    const g = parsed.groups.find((x) => pos.line >= x.startLine && pos.line <= x.endLine);
    if (g && parsed.errors.length === 0) {
      md.appendMarkdown(`**${escapeMd(g.name)}**\n\n${groupTableMarkdown(modelFromGroup(text, g))}\n\n`);
      md.appendMarkdown(commandLink('$(table) Editar em tabela', 'semaforoEnv.editGroup', [doc.uri.toString(), g.name]));
    }
    return new vscode.Hover(md, doc.lineAt(pos.line).range);
  }
}

class EnvDecorations implements vscode.Disposable {
  private readonly marker = vscode.window.createTextEditorDecorationType({ opacity: '0.55' });
  private readonly danger = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor('errorForeground'),
  });
  private readonly active = vscode.window.createTextEditorDecorationType({
    after: { contentText: '  ← ativa', color: new vscode.ThemeColor('descriptionForeground'), fontStyle: 'italic' },
  });

  update(editor: vscode.TextEditor): void {
    if (!isEnvDocument(editor.document)) return;
    const text = editor.document.getText();
    const lines = splitLines(text);
    const marker: vscode.Range[] = [];
    const danger: vscode.Range[] = [];
    lines.forEach((line, n) => {
      if (!MARKER_RE.test(line)) return;
      const d = /\s@danger\s*$/.exec(line);
      if (d) {
        const start = d.index + d[0].indexOf('@');
        marker.push(new vscode.Range(n, 0, n, start));
        danger.push(new vscode.Range(n, start, n, start + '@danger'.length));
      } else {
        marker.push(new vscode.Range(n, 0, n, line.length));
      }
    });
    const parsed = parseEnv(text);
    const active =
      parsed.errors.length > 0
        ? []
        : parsed.groups.flatMap((g) => {
            const o = activeOption(g);
            return o ? [new vscode.Range(o.markerLine, lines[o.markerLine].length, o.markerLine, lines[o.markerLine].length)] : [];
          });
    editor.setDecorations(this.marker, marker);
    editor.setDecorations(this.danger, danger);
    editor.setDecorations(this.active, active);
  }

  dispose(): void {
    this.marker.dispose();
    this.danger.dispose();
    this.active.dispose();
  }
}

/** Liga CodeLens, hover e decorações nos arquivos .env. `controlled` diz se o arquivo é o .env que o painel controla. */
export function registerEnvAssist(controlled: (uri: vscode.Uri) => boolean): { disposables: vscode.Disposable[]; refresh(): void } {
  const selector: vscode.DocumentSelector = { scheme: 'file', pattern: '**/.env*' };
  const lens = new EnvLens(controlled);
  const decorations = new EnvDecorations();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const decorateVisible = () => vscode.window.visibleTextEditors.forEach((e) => decorations.update(e));
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(decorateVisible, 150);
  };
  decorateVisible();
  return {
    refresh: () => {
      lens.refresh();
      schedule();
    },
    disposables: [
      lens,
      decorations,
      vscode.languages.registerCodeLensProvider(selector, lens),
      vscode.languages.registerHoverProvider(selector, new EnvHover()),
      vscode.window.onDidChangeVisibleTextEditors(schedule),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (isEnvDocument(e.document)) schedule();
      }),
      { dispose: () => timer && clearTimeout(timer) },
    ],
  };
}
