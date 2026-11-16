import * as vscode from 'vscode';
import * as net from 'net';
import { ServiceDef, commandMatches, normPath, serviceId, serviceUsesEnvDir } from './logic';

export type ServiceState = 'stopped' | 'starting' | 'running' | 'crashed';

export interface ServiceRuntime {
  readonly id: string;
  def: ServiceDef;
  state: ServiceState;
  terminal?: vscode.Terminal;
  execution?: vscode.TerminalShellExecution;
  /** Terminal sem shell integration: não dá pra saber quando o processo termina. */
  blind: boolean;
  stopRequested: boolean;
  lastExitCode?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tryConnect(host: string, port: number, timeout = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Verifica só em localhost se alguém está escutando na porta. */
export async function isPortOpen(port: number): Promise<boolean> {
  return (await tryConnect('127.0.0.1', port)) || (await tryConnect('::1', port));
}

/**
 * Sobe, para e reinicia os serviços configurados, cada um no próprio terminal visível.
 * Também "adota" um serviço que você iniciou na mão, se o comando bater.
 */
export class ServiceManager implements vscode.Disposable {
  private runtimes = new Map<string, ServiceRuntime>();
  private readonly waiters = new Map<vscode.TerminalShellExecution, () => void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly defs: () => ServiceDef[],
    private readonly cwdOf: (def: ServiceDef) => vscode.Uri | undefined,
  ) {
    this.sync();
    this.disposables.push(
      this.changed,
      vscode.window.onDidStartTerminalShellExecution((e) => this.onStart(e)),
      vscode.window.onDidEndTerminalShellExecution((e) => this.onEnd(e)),
      vscode.window.onDidCloseTerminal((t) => {
        for (const r of this.runtimes.values()) {
          if (r.terminal !== t) continue;
          r.terminal = undefined;
          r.execution = undefined;
          r.state = 'stopped';
        }
        this.changed.fire();
      }),
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  /** Recarrega as definições (depois de mudar as configurações). */
  sync(): void {
    const next = new Map<string, ServiceRuntime>();
    for (const def of this.defs()) {
      const id = serviceId(def);
      const prev = this.runtimes.get(id);
      next.set(id, prev ? { ...prev, def } : { id, def, state: 'stopped', blind: false, stopRequested: false });
    }
    this.runtimes = next;
    this.changed.fire();
  }

  list(): ServiceRuntime[] {
    return [...this.runtimes.values()];
  }

  get(id: string): ServiceRuntime | undefined {
    return this.runtimes.get(id);
  }

  systems(): string[] {
    return [...new Set(this.list().map((r) => r.def.system))];
  }

  byPort(port: number): ServiceRuntime | undefined {
    return this.list().find((r) => r.def.port === port);
  }

  isUp(r: ServiceRuntime): boolean {
    return r.state === 'running' || r.state === 'starting';
  }

  private alive(t: vscode.Terminal | undefined): t is vscode.Terminal {
    return !!t && vscode.window.terminals.includes(t) && t.exitStatus === undefined;
  }

  private onStart(e: vscode.TerminalShellExecutionStartEvent): void {
    const cmd = e.execution.commandLine.value;
    for (const r of this.runtimes.values()) {
      if (r.execution === e.execution) return; // já rastreado (iniciado por nós)
      if (!commandMatches(cmd, r.def.command)) continue;
      // Terminal do próprio serviço, ou outro terminal rodando na mesma pasta.
      const own = r.terminal === e.terminal;
      const dir = this.cwdOf(r.def);
      const sameDir = !!dir && !!e.execution.cwd && normPath(e.execution.cwd.fsPath) === normPath(dir.fsPath);
      if (!own && !(sameDir && !this.isUp(r))) continue;
      r.terminal = e.terminal;
      r.execution = e.execution;
      r.blind = false;
      r.stopRequested = false;
      void this.markStarting(r);
      return;
    }
  }

  private onEnd(e: vscode.TerminalShellExecutionEndEvent): void {
    this.waiters.get(e.execution)?.();
    this.waiters.delete(e.execution);
    for (const r of this.runtimes.values()) {
      if (r.execution !== e.execution) continue;
      r.execution = undefined;
      r.lastExitCode = e.exitCode;
      const crashed = !r.stopRequested && e.exitCode !== undefined && e.exitCode !== 0;
      r.state = crashed ? 'crashed' : 'stopped';
      r.stopRequested = false;
      this.changed.fire();
    }
  }

  /** "iniciando" até a porta responder (ou direto "rodando", se não houver porta). */
  private async markStarting(r: ServiceRuntime): Promise<void> {
    r.state = r.def.port ? 'starting' : 'running';
    this.changed.fire();
    if (!r.def.port) return;
    const exec = r.execution;
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      if (r.state !== 'starting' || (exec && r.execution !== exec)) return;
      if (await isPortOpen(r.def.port)) {
        r.state = 'running';
        this.changed.fire();
        return;
      }
    }
  }

  showLogs(id: string): void {
    const r = this.get(id);
    if (r && this.alive(r.terminal)) r.terminal.show(false);
    else void vscode.window.showInformationMessage(`${id}: ainda não foi iniciado nesta sessão.`);
  }

  async start(id: string): Promise<boolean> {
    const r = this.get(id);
    if (!r) return false;
    if (this.isUp(r)) {
      r.terminal?.show(true);
      return true;
    }
    if (r.def.port && (await isPortOpen(r.def.port))) {
      const choice = await vscode.window.showWarningMessage(
        `${id}: a porta ${r.def.port} já está em uso por outro processo.`,
        'Iniciar mesmo assim',
        'Cancelar',
      );
      if (choice !== 'Iniciar mesmo assim') return false;
    }
    let terminal = r.terminal;
    if (!this.alive(terminal)) {
      terminal = vscode.window.createTerminal({
        name: id,
        cwd: this.cwdOf(r.def),
        iconPath: new vscode.ThemeIcon('server-process'),
      });
      r.terminal = terminal;
    }
    await this.run(r, terminal);
    return true;
  }

  async stop(id: string): Promise<void> {
    const r = this.get(id);
    if (!r || !this.alive(r.terminal)) return;
    if (!this.isUp(r) && !r.blind) return;
    r.stopRequested = true;
    const exec = r.execution;
    r.terminal.sendText('\x03', false);
    if (exec) {
      if (!(await this.waitEnd(exec, 5000))) {
        r.terminal.sendText('\x03', false);
        if (!(await this.waitEnd(exec, 3000))) {
          r.terminal.sendText('Y', true); // cmd.exe: "Terminate batch job (Y/N)?"
          await this.waitEnd(exec, 2000);
        }
      }
    } else {
      await sleep(1500);
    }
    r.execution = undefined;
    r.blind = false;
    r.state = 'stopped';
    r.stopRequested = false;
    this.changed.fire();
    if (r.def.port) {
      for (let i = 0; i < 10 && (await isPortOpen(r.def.port)); i++) await sleep(500);
    }
  }

  async restart(id: string): Promise<boolean> {
    const r = this.get(id);
    if (!r) return false;
    if (this.isUp(r) || r.blind) await this.stop(id);
    return this.start(id);
  }

  async startSystem(system: string): Promise<void> {
    const list = this.list().filter((r) => r.def.system === system);
    for (const r of this.backFirst(list)) await this.start(r.id);
  }

  async stopSystem(system: string): Promise<void> {
    await Promise.all(this.list().filter((r) => r.def.system === system).map((r) => this.stop(r.id)));
  }

  async startAll(): Promise<void> {
    for (const r of this.backFirst(this.list())) await this.start(r.id);
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.list().map((r) => this.stop(r.id)));
  }

  /** Reinicia os serviços rodando que leem o .env desta pasta. Retorna os ids reiniciados. */
  async restartUsingEnv(envDir: vscode.Uri): Promise<string[]> {
    const targets = this.list().filter((r) => {
      const dir = this.cwdOf(r.def);
      return (this.isUp(r) || r.blind) && !!dir && serviceUsesEnvDir(dir.fsPath, envDir.fsPath);
    });
    for (const r of targets) await this.restart(r.id);
    return targets.map((r) => r.id);
  }

  /** Há serviços configurados que leem o .env desta pasta? */
  hasServiceForEnv(envDir: vscode.Uri): boolean {
    return this.list().some((r) => {
      const dir = this.cwdOf(r.def);
      return !!dir && serviceUsesEnvDir(dir.fsPath, envDir.fsPath);
    });
  }

  private backFirst(list: ServiceRuntime[]): ServiceRuntime[] {
    const rank = (r: ServiceRuntime) => (/back|api|server/i.test(r.def.name) ? 0 : /front|web|app/i.test(r.def.name) ? 2 : 1);
    return [...list].sort((a, b) => rank(a) - rank(b));
  }

  private async run(r: ServiceRuntime, terminal: vscode.Terminal): Promise<void> {
    terminal.show(true);
    const integration = terminal.shellIntegration ?? (await this.waitIntegration(terminal, 3000));
    r.stopRequested = false;
    if (integration) {
      // O evento onDidStartTerminalShellExecution marca o estado.
      const exec = integration.executeCommand(r.def.command);
      if (r.execution !== exec) {
        r.execution = exec;
        r.blind = false;
        void this.markStarting(r);
      }
    } else {
      terminal.sendText(r.def.command, true);
      r.execution = undefined;
      r.blind = true;
      void this.markStarting(r);
    }
  }

  private waitEnd(exec: vscode.TerminalShellExecution, ms: number): Promise<boolean> {
    const stillRunning = this.list().some((r) => r.execution === exec);
    if (!stillRunning) return Promise.resolve(true);
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

  private waitIntegration(terminal: vscode.Terminal, ms: number): Promise<vscode.TerminalShellIntegration | undefined> {
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
}
