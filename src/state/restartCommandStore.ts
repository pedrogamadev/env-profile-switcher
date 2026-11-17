import * as path from 'path';

/**
 * Persistência do reinício simples no estado do workspace (context.workspaceState).
 *
 * Nada aqui grava em settings.json: o comando de inicialização é guardado por pasta de projeto
 * (o diretório do package.json escolhido), então loja-api e loja-app têm cada um o seu.
 * O módulo não importa o "vscode" em tempo de execução, para poder ser testado com node --test.
 */

export const RESTART_COMMAND_PREFIX = 'semaforoEnv.restartCommand:';
const MODE_KEY = 'semaforoEnv.restartMode';
const TASK_KEY = 'semaforoEnv.restartTask';
const MIGRATED_KEY = 'semaforoEnv.restartSettingsMigrated';

export const RESTART_MODES = ['off', 'terminal', 'task', 'debug'] as const;
export type RestartMode = (typeof RESTART_MODES)[number];

/** Comando que inicia o servidor de uma pasta de projeto. */
export interface RestartCommand {
  command: string;
  /** Pasta absoluta onde o comando roda. */
  cwd: string;
}

export interface StoredRestartCommand extends RestartCommand {
  /** Caminho normalizado da pasta do projeto (o que vem depois do prefixo na chave). */
  folder: string;
}

/** O subconjunto de vscode.Memento usado aqui. */
export interface StateMemento {
  keys(): readonly string[];
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Valores antigos de semaforoEnv.restart.*, como lidos das configurações. */
export interface LegacyRestartSettings {
  mode?: unknown;
  command?: unknown;
  cwd?: unknown;
  task?: unknown;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Caminho absoluto normalizado: separadores e "." / ".." resolvidos, sem barra final.
 * No Windows o sistema de arquivos não diferencia maiúsculas, então tudo vira minúsculo
 * (o VS Code devolve "c:\" em Uri.fsPath, mas outras fontes devolvem "C:\").
 */
export function normalizeFolderPath(folderPath: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = pathApi(platform).resolve(folderPath);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function restartCommandKey(folderPath: string, platform: NodeJS.Platform = process.platform): string {
  return RESTART_COMMAND_PREFIX + normalizeFolderPath(folderPath, platform);
}

export function isRestartCommand(value: unknown): value is RestartCommand {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.command === 'string' && v.command.trim() !== '' && typeof v.cwd === 'string';
}

function isRestartMode(value: unknown): value is RestartMode {
  return typeof value === 'string' && (RESTART_MODES as readonly string[]).includes(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** child é a própria pasta parent ou fica dentro dela. Os dois já normalizados. */
function isInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const sep = pathApi(platform).sep;
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Quais comandos reiniciar quando o .env de envDir muda:
 * 1. o da própria pasta do .env, ou da pasta mais próxima acima dela;
 * 2. se não houver, todos os que ficam dentro dela (ex.: .env na raiz lido por loja-api e loja-app).
 */
export function selectForEnvDir<T extends { folder: string }>(
  envDir: string,
  entries: readonly T[],
  platform: NodeJS.Platform = process.platform,
): T[] {
  const dir = normalizeFolderPath(envDir, platform);
  const above = entries.filter((e) => isInside(dir, e.folder, platform));
  if (above.length > 0) return [above.reduce((a, b) => (b.folder.length > a.folder.length ? b : a))];
  return entries.filter((e) => isInside(e.folder, dir, platform));
}

export class RestartCommandStore {
  constructor(
    private readonly memento: StateMemento,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  // ── Comando por pasta ──

  get(folderPath: string): RestartCommand | undefined {
    const value = this.memento.get<unknown>(restartCommandKey(folderPath, this.platform));
    return isRestartCommand(value) ? { command: value.command, cwd: value.cwd } : undefined;
  }

  set(folderPath: string, value: RestartCommand): PromiseLike<void> {
    const command = value.command.trim();
    if (!command) throw new Error('O comando de inicialização não pode ser vazio.');
    return this.memento.update(restartCommandKey(folderPath, this.platform), {
      command,
      cwd: value.cwd || folderPath,
    } satisfies RestartCommand);
  }

  clear(folderPath: string): PromiseLike<void> {
    // undefined remove a chave do workspaceState.
    return this.memento.update(restartCommandKey(folderPath, this.platform), undefined);
  }

  /** Todas as pastas com comando salvo, em ordem de caminho. */
  list(): StoredRestartCommand[] {
    return this.memento
      .keys()
      .filter((k) => k.startsWith(RESTART_COMMAND_PREFIX))
      .flatMap((k) => {
        const value = this.memento.get<unknown>(k);
        return isRestartCommand(value)
          ? [{ folder: k.slice(RESTART_COMMAND_PREFIX.length), command: value.command, cwd: value.cwd }]
          : [];
      })
      .sort((a, b) => a.folder.localeCompare(b.folder));
  }

  forEnvDir(envDir: string): StoredRestartCommand[] {
    return selectForEnvDir(envDir, this.list(), this.platform);
  }

  // ── Modo (vale para o workspace inteiro) ──

  getMode(): RestartMode {
    const mode = this.memento.get<unknown>(MODE_KEY);
    return isRestartMode(mode) ? mode : 'off';
  }

  setMode(mode: RestartMode): PromiseLike<void> {
    return this.memento.update(MODE_KEY, mode);
  }

  getTask(): string {
    return nonEmpty(this.memento.get<unknown>(TASK_KEY)) ?? '';
  }

  setTask(name: string): PromiseLike<void> {
    return this.memento.update(TASK_KEY, name.trim());
  }

  // ── Migração de semaforoEnv.restart.* (até 0.4.0) ──

  /**
   * Copia uma única vez os valores antigos das configurações para o workspaceState.
   * O cwd antigo era relativo à primeira pasta do workspace (baseFolder).
   * Não sobrescreve o que já estiver salvo. Retorna true se copiou alguma coisa.
   */
  async migrateLegacy(legacy: LegacyRestartSettings, baseFolder: string): Promise<boolean> {
    if (this.memento.get<unknown>(MIGRATED_KEY) === true) return false;
    let migrated = false;

    const command = nonEmpty(legacy.command);
    if (command) {
      const rel = (nonEmpty(legacy.cwd) ?? '').split(/[\\/]+/).filter((p) => p && p !== '.');
      const folder = pathApi(this.platform).join(baseFolder, ...rel);
      if (!this.get(folder)) {
        await this.set(folder, { command, cwd: folder });
        migrated = true;
      }
    }

    const task = nonEmpty(legacy.task);
    if (task && !this.getTask()) {
      await this.setTask(task);
      migrated = true;
    }

    if (isRestartMode(legacy.mode) && legacy.mode !== 'off' && this.memento.get<unknown>(MODE_KEY) === undefined) {
      await this.setMode(legacy.mode);
      migrated = true;
    }

    await this.memento.update(MIGRATED_KEY, true);
    return migrated;
  }
}
