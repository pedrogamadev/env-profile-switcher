import * as vscode from 'vscode';
import { EnvGroup, EnvOption, ParseResult, formatError } from './parser';

export type Node =
  | { type: 'group'; group: EnvGroup }
  | { type: 'option'; group: EnvGroup; option: EnvOption }
  | { type: 'error'; line: number; label: string };

export class EnvTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private result: ParseResult | undefined;

  setResult(result: ParseResult | undefined): void {
    this.result = result;
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  getChildren(node?: Node): Node[] {
    if (!this.result) return [];
    if (!node) {
      if (this.result.errors.length > 0) {
        return this.result.errors.map((e) => ({
          type: 'error' as const,
          line: e.line,
          label: formatError(e),
        }));
      }
      return this.result.groups.map((group) => ({ type: 'group' as const, group }));
    }
    if (node.type === 'group') {
      return node.group.options.map((option) => ({
        type: 'option' as const,
        group: node.group,
        option,
      }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === 'error') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      item.tooltip = 'Corrija o .env para voltar a trocar perfis. Clique para ir até a linha.';
      item.command = {
        command: 'semaforoEnv.openFile',
        title: 'Abrir .env',
        arguments: [node.line],
      };
      return item;
    }

    if (node.type === 'group') {
      const { group } = node;
      const item = new vscode.TreeItem(group.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${group.name}`;
      item.contextValue = 'envGroup';
      if (group.state === 'inconsistent') {
        item.description = 'inconsistente';
        item.iconPath = new vscode.ThemeIcon(
          'warning',
          new vscode.ThemeColor('problemsWarningIcon.foreground'),
        );
        item.tooltip = 'Mais de uma opção ativa, nenhuma ativa ou uma opção com linhas misturadas. Escolha uma opção para corrigir.';
      } else {
        item.iconPath = new vscode.ThemeIcon('database');
      }
      return item;
    }

    const { group, option } = node;
    const item = new vscode.TreeItem(option.name, vscode.TreeItemCollapsibleState.None);
    item.id = `option:${group.name}:${option.name}`;
    item.contextValue = option.danger ? 'envOptionDanger' : 'envOption';

    const color = option.danger ? new vscode.ThemeColor('errorForeground') : undefined;
    if (option.state === 'active') {
      item.iconPath = new vscode.ThemeIcon(
        'pass-filled',
        color ?? new vscode.ThemeColor('testing.iconPassed'),
      );
    } else if (option.state === 'mixed') {
      item.iconPath = new vscode.ThemeIcon(
        'circle-slash',
        new vscode.ThemeColor('problemsWarningIcon.foreground'),
      );
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
      arguments: [group.name, option.name],
    };
    return item;
  }
}
