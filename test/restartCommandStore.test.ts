import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  RESTART_COMMAND_PREFIX,
  RestartCommandStore,
  StateMemento,
  normalizeFolderPath,
  restartCommandKey,
  selectForEnvDir,
} from '../src/state/restartCommandStore';

/** Imita o vscode.Memento: update com undefined remove a chave. */
class FakeMemento implements StateMemento {
  readonly data = new Map<string, unknown>();
  keys(): readonly string[] {
    return [...this.data.keys()];
  }
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, value);
    return Promise.resolve();
  }
}

const API = 'C:\\Users\\dev\\GitHub\\sgc\\sgc-api';
const APP = 'C:\\Users\\dev\\GitHub\\sgc\\sgc-app';
const ROOT = 'C:\\Users\\dev\\GitHub\\sgc';

function winStore(): { store: RestartCommandStore; memento: FakeMemento } {
  const memento = new FakeMemento();
  return { store: new RestartCommandStore(memento, 'win32'), memento };
}

test('chave = prefixo + caminho absoluto normalizado da pasta', () => {
  assert.equal(restartCommandKey(API, 'win32'), 'semaforoEnv.restartCommand:c:\\users\\dev\\github\\sgc\\sgc-api');
  // Letra do drive, barras, barra final e ".." não criam chaves diferentes no Windows.
  for (const variant of ['c:\\Users\\dev\\GitHub\\sgc\\sgc-api\\', 'C:/Users/dev/GitHub/sgc/sgc-api', 'C:\\Users\\dev\\GitHub\\sgc\\x\\..\\sgc-api']) {
    assert.equal(restartCommandKey(variant, 'win32'), restartCommandKey(API, 'win32'));
  }
  // Fora do Windows a caixa importa.
  assert.equal(normalizeFolderPath('/home/dev/Sgc/sgc-api/', 'linux'), '/home/dev/Sgc/sgc-api');
});

test('cada pasta guarda o seu próprio comando', async () => {
  const { store, memento } = winStore();
  await store.set(API, { command: 'npm run start:dev', cwd: API });
  await store.set(APP, { command: 'npm start', cwd: APP });

  assert.deepEqual(store.get(API), { command: 'npm run start:dev', cwd: API });
  assert.deepEqual(store.get('c:/users/dev/github/sgc/sgc-app/'), { command: 'npm start', cwd: APP });
  assert.equal(store.get(ROOT), undefined);
  assert.deepEqual(
    store.list().map((e) => e.command),
    ['npm run start:dev', 'npm start'],
  );
  assert.ok([...memento.data.keys()].every((k) => k.startsWith(RESTART_COMMAND_PREFIX)));
});

test('set sobrescreve só a pasta dela; clear remove só a pasta dela', async () => {
  const { store, memento } = winStore();
  await store.set(API, { command: 'npm run dev', cwd: API });
  await store.set(APP, { command: 'npm run dev', cwd: APP });
  await store.set(API, { command: '  npm run start:dev  ', cwd: API });
  assert.equal(store.get(API)?.command, 'npm run start:dev');
  assert.equal(store.get(APP)?.command, 'npm run dev');

  await store.clear(API);
  assert.equal(store.get(API), undefined);
  assert.equal(store.get(APP)?.command, 'npm run dev');
  assert.equal(memento.data.has(restartCommandKey(API, 'win32')), false);
});

test('set sem cwd usa a própria pasta; comando vazio é recusado', async () => {
  const { store } = winStore();
  await store.set(API, { command: 'npm start', cwd: '' });
  assert.equal(store.get(API)?.cwd, API);
  assert.throws(() => store.set(API, { command: '   ', cwd: API }));
});

test('valores corrompidos no workspaceState são ignorados', () => {
  const { store, memento } = winStore();
  memento.data.set(restartCommandKey(API, 'win32'), 'npm start');
  memento.data.set(restartCommandKey(APP, 'win32'), { command: '', cwd: APP });
  memento.data.set(restartCommandKey(ROOT, 'win32'), { command: 'npm start' });
  assert.equal(store.get(API), undefined);
  assert.equal(store.get(APP), undefined);
  assert.equal(store.get(ROOT), undefined);
  assert.deepEqual(store.list(), []);
});

test('modo padrão é off; modo e task ficam no workspaceState', async () => {
  const { store, memento } = winStore();
  assert.equal(store.getMode(), 'off');
  await store.setMode('terminal');
  assert.equal(store.getMode(), 'terminal');
  memento.data.set('semaforoEnv.restartMode', 'qualquer');
  assert.equal(store.getMode(), 'off');
  await store.setTask('  dev  ');
  assert.equal(store.getTask(), 'dev');
});

test('selectForEnvDir: a pasta do .env, ou a mais próxima acima dela', () => {
  const n = (p: string) => normalizeFolderPath(p, 'win32');
  const entries = [{ folder: n(ROOT) }, { folder: n(API) }, { folder: n(APP) }];
  assert.deepEqual(selectForEnvDir(API, entries, 'win32'), [{ folder: n(API) }]);
  assert.deepEqual(selectForEnvDir(`${API}\\config`, entries, 'win32'), [{ folder: n(API) }]);
  assert.deepEqual(selectForEnvDir(ROOT, entries, 'win32'), [{ folder: n(ROOT) }]);
});

test('selectForEnvDir: .env na raiz reinicia os projetos de dentro', () => {
  const n = (p: string) => normalizeFolderPath(p, 'win32');
  const entries = [{ folder: n(API) }, { folder: n(APP) }];
  assert.deepEqual(selectForEnvDir(ROOT, entries, 'win32'), entries);
  // Pasta irmã com prefixo parecido não conta.
  assert.deepEqual(selectForEnvDir(`${API}-old`, entries, 'win32'), []);
  assert.deepEqual(selectForEnvDir('C:\\outro', entries, 'win32'), []);
});

test('migração: copia restart.* uma vez, resolvendo o cwd antigo a partir da primeira pasta', async () => {
  const { store } = winStore();
  const migrated = await store.migrateLegacy({ mode: 'terminal', command: 'npm run start:dev', cwd: 'sgc-api' }, ROOT);
  assert.equal(migrated, true);
  assert.deepEqual(store.get(API), { command: 'npm run start:dev', cwd: 'C:\\Users\\dev\\GitHub\\sgc\\sgc-api' });
  assert.equal(store.getMode(), 'terminal');

  // Segunda vez não lê mais nada, mesmo com outros valores.
  await store.clear(API);
  assert.equal(await store.migrateLegacy({ mode: 'debug', command: 'npm start', cwd: '' }, ROOT), false);
  assert.equal(store.get(API), undefined);
  assert.equal(store.get(ROOT), undefined);
  assert.equal(store.getMode(), 'terminal');
});

test('migração: não sobrescreve o que já foi salvo e ignora valores inválidos', async () => {
  const { store } = winStore();
  await store.set(ROOT, { command: 'npm run dev', cwd: ROOT });
  await store.setMode('debug');
  const migrated = await store.migrateLegacy({ mode: 'terminal', command: 'npm start', cwd: 42, task: ['x'] }, ROOT);
  assert.equal(migrated, false);
  assert.equal(store.get(ROOT)?.command, 'npm run dev');
  assert.equal(store.getMode(), 'debug');
  assert.equal(store.getTask(), '');
});

test('migração sem nada nas configurações só marca como feita', async () => {
  const { store, memento } = winStore();
  assert.equal(await store.migrateLegacy({}, ROOT), false);
  assert.equal(memento.data.get('semaforoEnv.restartSettingsMigrated'), true);
  assert.deepEqual(store.list(), []);
  assert.equal(store.getMode(), 'off');
});
