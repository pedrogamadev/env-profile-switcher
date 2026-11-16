import * as vscode from 'vscode';
import { ServiceManager, ServiceRuntime, ServiceState } from './services';

export interface DependencyWarning {
  text: string;
  serviceId: string;
}

export type SvcNode =
  | { type: 'warning'; warning: DependencyWarning }
  | { type: 'system'; system: string }
  | { type: 'service'; runtime: ServiceRuntime };

const STATE: Record<ServiceState, { label: string; color: string; icon: string }> = {
  running: { label: 'rodando', color: 'testing.iconPassed', icon: 'circle-filled' },
  starting: { label: 'iniciando...', color: 'problemsWarningIcon.foreground', icon: 'loading~spin' },
  stopped: { label: 'parado', color: 'disabledForeground', icon: 'circle-filled' },
  crashed: { label: 'caiu', color: 'errorForeground', icon: 'circle-filled' },
};

export class ServicesTreeProvider implements vscode.TreeDataProvider<SvcNode> {
  private readonly changed = new vscode.EventEmitter<SvcNode | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private warnings: DependencyWarning[] = [];

  constructor(private readonly services: ServiceManager) {}

  refresh(): void {
    this.changed.fire();
  }

  setWarnings(warnings: DependencyWarning[]): void {
    this.warnings = warnings;
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  getChildren(node?: SvcNode): SvcNode[] {
    if (!node) {
      const systems = this.services.systems();
      if (systems.length === 0) return [];
      const ws = this.warnings.map((warning) => ({ type: 'warning' as const, warning }));
      return [...ws, ...systems.map((system) => ({ type: 'system' as const, system }))];
    }
    if (node.type === 'system') {
      return this.services
        .list()
        .filter((r) => r.def.system === node.system)
        .map((runtime) => ({ type: 'service' as const, runtime }));
    }
    return [];
  }

  getTreeItem(node: SvcNode): vscode.TreeItem {
    if (node.type === 'warning') {
      const item = new vscode.TreeItem(node.warning.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
      item.tooltip = `${node.warning.text}\nClique para iniciar ${node.warning.serviceId}.`;
      item.contextValue = 'svcWarning';
      item.command = { command: 'semaforoEnv.service.start', title: 'Iniciar', arguments: [node.warning.serviceId] };
      return item;
    }

    if (node.type === 'system') {
      const list = this.services.list().filter((r) => r.def.system === node.system);
      const up = list.filter((r) => this.services.isUp(r)).length;
      const item = new vscode.TreeItem(node.system, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `svc-system:${node.system}`;
      item.iconPath = new vscode.ThemeIcon('layers');
      item.description = `${up}/${list.length} rodando`;
      item.contextValue = up > 0 ? 'svcSystemUp' : 'svcSystem';
      return item;
    }

    const r = node.runtime;
    const st = STATE[r.state];
    const item = new vscode.TreeItem(r.def.name, vscode.TreeItemCollapsibleState.None);
    item.id = `svc:${r.id}`;
    item.iconPath = new vscode.ThemeIcon(st.icon, new vscode.ThemeColor(st.color));
    const crashInfo = r.state === 'crashed' && r.lastExitCode !== undefined ? ` (exit ${r.lastExitCode})` : '';
    item.description = `${r.def.port ? ':' + r.def.port + ' · ' : ''}${st.label}${crashInfo}`;
    item.tooltip = `${r.id}\n${r.def.command}${r.def.cwd ? `\nem ${r.def.cwd}` : ''}`;
    item.contextValue = this.services.isUp(r) ? 'svcUp' : 'svcDown';
    item.command = { command: 'semaforoEnv.service.logs', title: 'Ver logs', arguments: [r.id] };
    return item;
  }
}
