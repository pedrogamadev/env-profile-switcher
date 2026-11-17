import * as vscode from 'vscode';
import { commandMatches } from './logic';
import { RestartMode, normalizeFolderPath } from './state/restartCommandStore';

export type { RestartMode };

export interface RestartConfig {
  mode: RestartMode;
  command: string;
  /** Pasta absoluta onde o comando roda (modo terminal). */
  cwd: string;
  task: string;
  /** Nome curto da pasta do projeto (ex.: sgc-api), usado no terminal e nas mensagens. */
  label?: string;
}

interface Tracked {
  terminal: vscode.Terminal;
  commandLine: string;
  /** Execução em andamento (quando o terminal tem shell integration). */
  execution?: vscode.TerminalShellExecution;
  /** Sem shell integration não sabemos se o processo terminou: assume que está rodando. */
  blind: boolean;
}

const MANAGED_NAME = 'Semáforo · servidor';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sabe iniciar e reiniciar o servidor de desenvolvimento do projeto:
 * - "terminal": encontra o terminal onde o comando está rodando (o seu), manda Ctrl+C e roda de novo.
 *   Se não achar, abre um terminal visível próprio.
 * - "task": reinicia uma task do VS Code.
 * - "debug": reinicia a sessão de debug ativa.
 */
export class ServerManager implements vscode.Disposable {
  private tracked: Tracked | undefined;
  private readonly waiters = new Map<vscode.TerminalShellExecution, () => void>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly config: () => RestartConfig) {
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((e) => {
        const cfg = this.config();
        if (cfg.mode !== 'terminal' || !cfg.command) return;
        if (!commandMatches(e.execution.commandLine.value, cfg.command)) return;
        // Vários projetos podem usar o mesmo comando (ex.: npm run dev): só adota o da pasta certa.
        const ranIn = e.execution.cwd ?? e.terminal.shellIntegration?.cwd;
        if (cfg.cwd && ranIn && normalizeFolderPath(ranIn.fsPath) !== normalizeFolderPath(cfg.cwd)) return;
        this.tracked = {
          terminal: e.terminal,
          commandLine: e.execution.commandLine.value.trim() || cfg.command,
          execution: e.execution,
          blind: false,
        };
      }),
      vscode.window.onDidEndTerminalShellExecution((e) => {
        if (this.tracked?.execution === e.execution) this.tracked.execution = undefined;
        this.waiters.get(e.execution)?.();
        this.waiters.delete(e.execution);
      }),
      vscode.window.onDidCloseTerminal((t) => {
        if (this.tracked?.terminal === t) this.tracked = undefined;
      }),
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  /** Descrição curta para tooltips. */
  describe(): string {
    const cfg = this.config();
    switch (cfg.mode) {
      case 'terminal':
        if (!cfg.command) return 'terminal (comando não configurado)';
        return cfg.label ? `reinicia "${cfg.command}" em ${cfg.label}` : `reinicia "${cfg.command}"`;
      case 'task':
        return cfg.task ? `reinicia a task "${cfg.task}"` : 'task (nome não configurado)';
      case 'debug':
        return 'reinicia a sessão de debug';
      default:
        return 'desligado';
    }
  }

  isRunning(): boolean {
    const t = this.tracked;
    return !!t && this.terminalAlive(t.terminal) && (!!t.execution || t.blind);
  }

  /** Inicia o servidor (ou mostra o terminal, se já estiver rodando). */
  async start(): Promise<boolean> {
    const cfg = this.config();
    if (cfg.mode === 'task') return this.runTask(cfg.task, false);
    if (cfg.mode === 'debug') {
      await vscode.commands.executeCommand('workbench.action.debug.start');
      return true;
    }
    if (cfg.mode !== 'terminal' || !cfg.command) return false;
    if (this.isRunning()) {
      this.tracked!.terminal.show(true);
      return true;
    }
    if (this.tracked && this.terminalAlive(this.tracked.terminal)) {
      await this.run(this.tracked.terminal, this.tracked.commandLine);
      return true;
    }
    await this.startManaged(cfg);
    return true;
  }

  /** Reinicia conforme o modo configurado. Retorna false se não fez nada. */
  async restart(): Promise<boolean> {
    const cfg = this.config();
    switch (cfg.mode) {
      case 'terminal':
        return this.restartTerminal(cfg);
      case 'task':
        return this.runTask(cfg.task, true);
      case 'debug':
        if (!vscode.debug.activeDebugSession) return false;
        await vscode.commands.executeCommand('workbench.action.debug.restart');
        return true;
      default:
        return false;
    }
  }

  private terminalAlive(t: vscode.Terminal): boolean {
    return vscode.window.terminals.includes(t) && t.exitStatus === undefined;
  }

  private async restartTerminal(cfg: RestartConfig): Promise<boolean> {
    if (!cfg.command) return false;
    let t = this.tracked && this.terminalAlive(this.tracked.terminal) ? this.tracked : undefined;

    if (!t) {
      // Não vimos o servidor subir (ex.: ele já rodava antes do VS Code abrir a extensão).
      const others = vscode.window.terminals.filter((x) => x.exitStatus === undefined);
      if (others.length > 0) {
        const pick = await vscode.window.showQuickPick(
          [
            ...others.map((term) => ({
              label: `$(terminal) ${term.name}`,
              description: 'parar o que estiver rodando e iniciar o servidor aqui',
              term,
            })),
            { label: `$(add) Terminal novo`, description: this.terminalName(cfg), term: undefined },
          ],
          {
            placeHolder: `Em qual terminal o servidor está rodando? (${cfg.label ? `${cfg.label}: ` : ''}${cfg.command})`,
          },
        );
        if (!pick) return false;
        if (pick.term) {
          t = { terminal: pick.term, commandLine: cfg.command, blind: !pick.term.shellIntegration };
          this.tracked = t;
          await this.stop(t, true);
          await this.run(t.terminal, cfg.command);
          return true;
        }
      }
      await this.startManaged(cfg);
      return true;
    }

    if (t.execution || t.blind) await this.stop(t, false);
    await this.run(t.terminal, t.commandLine);
    return true;
  }

  /** Ctrl+C no terminal e espera o processo terminar. */
  private async stop(t: Tracked, unknownState: boolean): Promise<void> {
    const exec = t.execution;
    t.terminal.sendText('\x03', false);
    if (exec) {
      if (await this.waitEnd(exec, 5000)) return;
      t.terminal.sendText('\x03', false);
      if (await this.waitEnd(exec, 3000)) return;
      // cmd.exe pergunta "Terminate batch job (Y/N)?"
      t.terminal.sendText('Y', true);
      await this.waitEnd(exec, 2000);
      return;
    }
    // Sem shell integration (ou estado desconhecido): espera um tempo fixo.
    await sleep(unknownState ? 1200 : 1500);
  }

  private waitEnd(exec: vscode.TerminalShellExecution, ms: number): Promise<boolean> {
    if (this.tracked?.execution !== exec) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(exec);
        resolve(false);
      }, ms);
      this.waiters.set(exec, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private async run(terminal: vscode.Terminal, commandLine: string): Promise<void> {
    terminal.show(true);
    const integration = terminal.shellIntegration ?? (await this.waitIntegration(terminal, 3000));
    if (integration) {
      const execution = integration.executeCommand(commandLine);
      this.tracked = { terminal, commandLine, execution, blind: false };
    } else {
      terminal.sendText(commandLine, true);
      this.tracked = { terminal, commandLine, blind: true };
    }
  }

  private waitIntegration(
    terminal: vscode.Terminal,
    ms: number,
  ): Promise<vscode.TerminalShellIntegration | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sub.dispose();
        resolve(undefined);
      }, ms);
      const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal !== terminal) return;
        clearTimeout(timer);
        sub.dispose();
        resolve(e.shellIntegration);
      });
    });
  }

  /** Um terminal próprio por pasta de projeto. */
  private terminalName(cfg: RestartConfig): string {
    return cfg.label ? `Semáforo · ${cfg.label}` : MANAGED_NAME;
  }

  private async startManaged(cfg: RestartConfig): Promise<void> {
    const name = this.terminalName(cfg);
    const existing = vscode.window.terminals.find((t) => t.name === name && t.exitStatus === undefined);
    const terminal =
      existing ??
      vscode.window.createTerminal({
        name,
        cwd: cfg.cwd ? vscode.Uri.file(cfg.cwd) : undefined,
        iconPath: new vscode.ThemeIcon('server-process'),
      });
    await this.run(terminal, cfg.command);
  }

  private async runTask(name: string, restart: boolean): Promise<boolean> {
    if (!name) return false;
    if (restart) {
      const running = vscode.tasks.taskExecutions.find((e) => e.task.name === name);
      if (running) {
        const ended = new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            sub.dispose();
            resolve();
          }, 5000);
          const sub = vscode.tasks.onDidEndTask((e) => {
            if (e.execution !== running) return;
            clearTimeout(timer);
            sub.dispose();
            resolve();
          });
        });
        running.terminate();
        await ended;
      }
    }
    const task = (await vscode.tasks.fetchTasks()).find((t) => t.name === name);
    if (!task) return false;
    await vscode.tasks.executeTask(task);
    return true;
  }
}
