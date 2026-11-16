import * as vscode from 'vscode';
import { EnvGroup, EnvOption, ParseResult, formatError } from './parser';

export type Light = 'green' | 'yellow' | 'red' | 'error';

/** Um sistema = uma pasta do workspace com o seu .env. */
export interface EnvView {
  key: string;
  name: string;
  fileLabel: string;
  result: ParseResult;
  light: Light;
}

export type Node =
  | { type: 'system'; ctx: EnvView }
  | { type: 'group'; ctx: EnvView; group: EnvGroup }
  | { type: 'option'; ctx: EnvView; group: EnvGroup; option: EnvOption }
  | { type: 'error'; ctx: EnvView; line: number; label: string };

const LIGHT_COLOR: Record<Light, string> = {
  green: 'testing.iconPassed',
  yellow: 'problemsWarningIcon.foreground',
  red: 'errorForeground',
  error: 'errorForeground',
};

export class EnvTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private views: EnvView[] = [];

  setViews(views: EnvView[]): void {
    this.views = views;
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  private contentOf(ctx: EnvView): Node[] {
    if (ctx.result.errors.length > 0) {
      return ctx.result.errors.map((e) => ({ type: 'error' as const, ctx, line: e.line, label: formatError(e) }));
    }
    return ctx.result.groups.map((group) => ({ type: 'group' as const, ctx, group }));
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      if (this.views.length === 0) return [];
      if (this.views.length === 1) return this.contentOf(this.views[0]);
      return this.views.map((ctx) => ({ type: 'system' as const, ctx }));
    }
    if (node.type === 'system') return this.contentOf(node.ctx);
    if (node.type === 'group') {
      return node.group.options.map((option) => ({ type: 'option' as const, ctx: node.ctx, group: node.group, option }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === 'system') {
      const item = new vscode.TreeItem(node.ctx.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `system:${node.ctx.key}`;
      item.description = node.ctx.fileLabel;
      item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(LIGHT_COLOR[node.ctx.light]));
      item.contextValue = 'envSystem';
      return item;
    }

    if (node.type === 'error') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      item.tooltip = 'Corrija o .env para voltar a trocar perfis. Clique para ir até a linha.';
      item.command = { command: 'semaforoEnv.openFile', title: 'Abrir .env', arguments: [node.line, node.ctx.key] };
      return item;
    }

    if (node.type === 'group') {
      const { group } = node;
      const item = new vscode.TreeItem(group.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${node.ctx.key}:${group.name}`;
      item.contextValue = 'envGroup';
      if (group.state === 'inconsistent') {
        item.description = 'inconsistente';
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        item.tooltip = 'Mais de uma opção ativa, nenhuma ativa ou uma opção com linhas misturadas. Escolha uma opção para corrigir.';
      } else {
        item.iconPath = new vscode.ThemeIcon('database');
      }
      return item;
    }

    const { group, option } = node;
    const item = new vscode.TreeItem(option.name, vscode.TreeItemCollapsibleState.None);
    item.id = `option:${node.ctx.key}:${group.name}:${option.name}`;
    item.contextValue = option.danger ? 'envOptionDanger' : 'envOption';

    const color = option.danger ? new vscode.ThemeColor('errorForeground') : undefined;
    if (option.state === 'active') {
      item.iconPath = new vscode.ThemeIcon('pass-filled', color ?? new vscode.ThemeColor('testing.iconPassed'));
    } else if (option.state === 'mixed') {
      item.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    } else {
      item.iconPath = new vscode.ThemeIcon('circle-large-outline', color);
    }

    const tags: string[] = [];
    if (option.danger) tags.push('remoto');
    if (option.state === 'mixed') tags.push('misto');
    if (tags.length) item.description = tags.join(' · ');

    // Só nomes de variáveis, nunca valores.
    item.tooltip = `Variáveis: ${option.keys.join(', ') || '(nenhuma)'}`;
    item.command = {
      command: 'semaforoEnv.selectOption',
      title: 'Selecionar opção',
      arguments: [group.name, option.name, node.ctx.key],
    };
    return item;
  }
}
