import * as vscode from 'vscode';
import * as net from 'net';
import {
  ServiceDef,
  TerminalInfo,
  commandMatches,
  normPath,
  pickRunningTerminal,
  pickStartTerminal,
  serviceId,
  serviceUsesEnvDir,
} from './logic';

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
  /** Quando o painel parou o serviço por último (a porta pode demorar a fechar). */
  stoppedAt?: number;
  /** Conferências seguidas com a porta fechada, para quem roda sem execução rastreada. */
  closedChecks?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Depois de parar um serviço, por quanto tempo não readotá-lo só porque a porta ainda responde. */
const STOP_GRACE_MS = 10_000;
/** Intervalo da conferência com a realidade enquanto o painel Serviços está visível. */
const POLL_MS = 4000;

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

/** Verifica só em localhost (IPv4 e IPv6 em paralelo) se alguém está escutando na porta. */
export function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let pending = 2;
    const done = (ok: boolean) => {
      if (ok) resolve(true);
      else if (--pending === 0) resolve(false);
    };
    void tryConnect('127.0.0.1', port).then(done);
    void tryConnect('::1', port).then(done);
  });
}

/**
 * Sobe, para e reinicia os serviços configurados, cada um no próprio terminal visível.
 * Também "adota" um serviço que você iniciou na mão, pelo comando digitado ou pela porta aberta.
 */
export class ServiceManager implements vscode.Disposable {
  private runtimes = new Map<string, ServiceRuntime>();
  /**
   * O que os eventos de shell integration contam de cada terminal:
   * a execução em andamento, ou null se está ocioso. Sem entrada = não sabemos.
   */
  private readonly activity = new Map<vscode.Terminal, vscode.TerminalShellExecution | null>();
  private readonly waiters = new Map<vscode.TerminalShellExecution, () => void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private reconciling: Promise<void> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly defs: () => ServiceDef[],
    private readonly cwdOf: (def: ServiceDef) => vscode.Uri | undefined,
    private readonly log?: vscode.LogOutputChannel,
  ) {
    this.sync();
    this.disposables.push(
      this.changed,
      vscode.window.onDidStartTerminalShellExecution((e) => this.onStart(e)),
      vscode.window.onDidEndTerminalShellExecution((e) => this.onEnd(e)),
      vscode.window.onDidCloseTerminal((t) => this.onClose(t)),
      { dispose: () => this.setPolling(false) },
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  /** Recarrega as definições (depois de mudar as configurações). Mantém os mesmos objetos de estado. */
  sync(): void {
    const next = new Map<string, ServiceRuntime>();
    for (const def of this.defs()) {
      const id = serviceId(def);
      const prev = this.runtimes.get(id);
      if (prev) {
        prev.def = def;
        next.set(id, prev);
      } else {
        next.set(id, { id, def, state: 'stopped', blind: false, stopRequested: false });
      }
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

  /** Liga ou desliga a conferência periódica (enquanto o painel Serviços está visível). */
  setPolling(on: boolean): void {
    if (on && !this.pollTimer) {
      this.pollTimer = setInterval(() => void this.reconcile(), POLL_MS);
      void this.reconcile();
    } else if (!on && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private alive(t: vscode.Terminal | undefined): t is vscode.Terminal {
    return !!t && vscode.window.terminals.includes(t) && t.exitStatus === undefined;
  }

  /** A execução que o serviço acompanha ainda está rodando, segundo os eventos do terminal? */
  private hasLiveExecution(r: ServiceRuntime): boolean {
    return !!r.execution && !!r.terminal && this.activity.get(r.terminal) === r.execution;
  }

  private recentlyStopped(r: ServiceRuntime): boolean {
    return !!r.stoppedAt && Date.now() - r.stoppedAt < STOP_GRACE_MS;
  }

  private inServiceDir(r: ServiceRuntime, fsPath: string): boolean {
    const dir = this.cwdOf(r.def);
    return !!dir && normPath(dir.fsPath) === normPath(fsPath);
  }

  private onStart(e: vscode.TerminalShellExecutionStartEvent): void {
    this.activity.set(e.terminal, e.execution);
    this.log?.trace(
      `início: "${e.execution.commandLine.value}" em "${e.terminal.name}" (${e.execution.cwd?.fsPath ?? e.terminal.shellIntegration?.cwd?.fsPath ?? 'pasta desconhecida'})`,
    );
    if (this.list().some((r) => r.execution === e.execution)) return; // iniciado pelo painel
    const r = this.matchExecution(e.terminal, e.execution);
    if (!r) return;
    this.adopt(r, e.terminal, e.execution, 'comando digitado no terminal');
    void this.markStarting(r);
  }

  private onEnd(e: vscode.TerminalShellExecutionEndEvent): void {
    // Um fim atrasado não pode apagar um comando mais novo no mesmo terminal.
    const current = this.activity.get(e.terminal);
    if (current === undefined || current === e.execution) this.activity.set(e.terminal, null);
    this.log?.trace(`fim: "${e.execution.commandLine.value}" em "${e.terminal.name}" (exit ${e.exitCode ?? '?'})`);
    this.waiters.get(e.execution)?.();
    this.waiters.delete(e.execution);
    for (const r of this.runtimes.values()) {
      if (r.execution !== e.execution) continue;
      r.execution = undefined;
      r.lastExitCode = e.exitCode;
      const crashed = !r.stopRequested && e.exitCode !== undefined && e.exitCode !== 0;
      r.state = crashed ? 'crashed' : 'stopped';
      r.stopRequested = false;
      this.log?.info(`${r.id}: ${crashed ? `caiu (exit ${e.exitCode})` : 'parado'}.`);
      this.changed.fire();
    }
  }

  private onClose(t: vscode.Terminal): void {
    this.activity.delete(t);
    let changed = false;
    for (const r of this.runtimes.values()) {
      if (r.terminal !== t) continue;
      r.terminal = undefined;
      r.execution = undefined;
      r.blind = false;
      r.state = 'stopped';
      changed = true;
    }
    if (changed) this.changed.fire();
  }

  /** Serviço que essa execução (iniciada fora do painel) está rodando, se houver. */
  private matchExecution(terminal: vscode.Terminal, exec: vscode.TerminalShellExecution): ServiceRuntime | undefined {
    const candidates = this.list().filter((r) => commandMatches(exec.commandLine.value, r.def.command));
    if (candidates.length === 0) return undefined;
    // O terminal já era do serviço.
    const own = candidates.find((r) => r.terminal === terminal);
    if (own) return own;
    // Vários sistemas podem usar o mesmo comando (ex.: npm run dev): decide pela pasta.
    const ranIn = exec.cwd ?? terminal.shellIntegration?.cwd;
    if (!ranIn) return undefined;
    // Um serviço marcado como de pé sem execução viva está desatualizado e pode ser readotado.
    return candidates.find((r) => !this.hasLiveExecution(r) && this.inServiceDir(r, ranIn.fsPath));
  }

  /** Passa a acompanhar o serviço nesse terminal. O terminal fica só com ele. */
  private adopt(
    r: ServiceRuntime,
    terminal: vscode.Terminal,
    exec: vscode.TerminalShellExecution | undefined,
    why: string,
  ): void {
    for (const o of this.runtimes.values()) {
      if (o === r || o.terminal !== terminal) continue;
      o.terminal = undefined;
      if (this.isUp(o)) {
        o.state = 'stopped';
        o.execution = undefined;
        o.blind = false;
      }
    }
    r.terminal = terminal;
    r.execution = exec;
    r.blind = !exec;
    r.stopRequested = false;
    r.closedChecks = 0;
    this.log?.info(`${r.id}: acompanhando o terminal "${terminal.name}" (${why}).`);
  }

  private termInfo(t: vscode.Terminal, r: ServiceRuntime): TerminalInfo {
    const current = this.activity.get(t);
    return {
      cwd: (current?.cwd ?? t.shellIntegration?.cwd)?.fsPath,
      activity: current === undefined ? 'unknown' : current === null ? 'idle' : 'busy',
      home: r.terminal === t,
      ownedByOther: this.list().some((o) => o !== r && o.terminal === t),
      active: vscode.window.activeTerminal === t,
      commandMatches: !!current && commandMatches(current.commandLine.value, r.def.command),
    };
  }

  private liveTerminals(): vscode.Terminal[] {
    return vscode.window.terminals.filter((t) => this.alive(t));
  }

  /**
   * Confere o painel com a realidade. Para quem tem porta, ela é a fonte da verdade:
   * porta aberta com um terminal na pasta do serviço = rodando (mesmo que o início tenha passado
   * despercebido); porta fechada sem execução acompanhada = parado.
   */
  reconcile(): Promise<void> {
    this.reconciling ??= this.doReconcile()
      .catch((err: unknown) => this.log?.error(`Falha ao conferir os serviços: ${String(err)}`))
      .finally(() => (this.reconciling = undefined));
    return this.reconciling;
  }

  private async doReconcile(): Promise<void> {
    const ports = [...new Set(this.list().flatMap((r) => (r.def.port ? [r.def.port] : [])))];
    if (ports.length === 0) return;
    const open = new Map(await Promise.all(ports.map(async (p) => [p, await isPortOpen(p)] as const)));
    let changed = false;

    for (const r of this.list()) {
      const port = r.def.port;
      if (!port) continue;

      if (open.get(port)) {
        r.closedChecks = 0;
        if (this.isUp(r) || this.recentlyStopped(r)) continue;
        // Dois sistemas na mesma porta não rodam juntos: se outro já está de pé, a porta é dele.
        if (this.list().some((o) => o !== r && o.def.port === port && this.isUp(o))) continue;
        const terms = this.liveTerminals();
        const i = pickRunningTerminal(terms.map((t) => this.termInfo(t, r)), this.cwdOf(r.def)?.fsPath);
        if (i < 0) continue; // nenhum terminal na pasta do serviço: a porta pode ser de outro processo
        this.adopt(r, terms[i], this.activity.get(terms[i]) ?? undefined, `porta ${port} respondendo`);
        r.state = 'running';
        changed = true;
      } else if (r.state === 'running' && !this.hasLiveExecution(r)) {
        // Rodando sem execução acompanhada (terminal sem shell integration ou fim perdido) e a porta fechou.
        r.closedChecks = (r.closedChecks ?? 0) + 1;
        if (r.closedChecks < 2) continue; // o watch reinicia o app e a porta fecha por uns segundos
        this.log?.info(`${r.id}: porta ${port} fechada, marcado como parado.`);
        r.state = 'stopped';
        r.execution = undefined;
        r.blind = false;
        r.closedChecks = 0;
        changed = true;
      }
    }

    if (changed) this.changed.fire();
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
    await this.reconcile();
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
    await this.run(r, this.terminalForStart(r));
    return true;
  }

  /**
   * Terminal onde iniciar: o do serviço ou outro livre na mesma pasta (ex.: o seu, dividido).
   * Se não houver, abre um novo dividido ao lado do outro serviço do mesmo sistema.
   */
  private terminalForStart(r: ServiceRuntime): vscode.Terminal {
    const terms = this.liveTerminals();
    const i = pickStartTerminal(terms.map((t) => this.termInfo(t, r)), this.cwdOf(r.def)?.fsPath);
    if (i >= 0) {
      if (terms[i] !== r.terminal) this.log?.info(`${r.id}: reaproveitando o terminal "${terms[i].name}".`);
      r.terminal = terms[i];
      return terms[i];
    }
    const sibling = this.list().find((o) => o !== r && o.def.system === r.def.system && this.alive(o.terminal));
    const terminal = vscode.window.createTerminal({
      name: r.id,
      cwd: this.cwdOf(r.def),
      iconPath: new vscode.ThemeIcon('server-process'),
      ...(sibling?.terminal ? { location: { parentTerminal: sibling.terminal } } : {}),
    });
    this.log?.info(`${r.id}: terminal novo${sibling ? `, dividido ao lado de ${sibling.id}` : ''}.`);
    r.terminal = terminal;
    return terminal;
  }

  async stop(id: string): Promise<void> {
    const r = this.get(id);
    if (!r) return;
    // Sem saber onde ele roda, confere antes (pode ter sido iniciado na mão).
    if (!this.alive(r.terminal) || (!this.isUp(r) && !r.blind)) await this.reconcile();
    if (!this.isUp(r) && !r.blind) return;
    if (!this.alive(r.terminal)) return;
    r.stopRequested = true;
    r.stoppedAt = Date.now();
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
    await this.reconcile();
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
    r.stoppedAt = undefined;
    r.closedChecks = 0;
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
