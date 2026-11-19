import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseEnv, applyEdits, splitLines } from '../src/parser';
import {
  DEFAULT_GUARD_PATTERNS,
  activeDangers,
  commandMatches,
  detectPackageManager,
  matchesGuard,
  planAllLocal,
  rankDevScripts,
  safeOption,
  scriptCommand,
} from '../src/logic';

const ENV = [
  '# @group Banco principal',
  '# @option local',
  '# DATABASE_URL=local',
  '# @option teste',
  '# DATABASE_URL=teste',
  '# @option homolog @danger',
  'DATABASE_URL=homolog',
  '# @end',
  '# @group API do Estoque',
  '# @option local',
  '# ESTOQUE_API_URL=local',
  '# @option homolog @danger',
  'ESTOQUE_API_URL=homolog',
  '# @end',
  '# @group Cache',
  '# @option local',
  'REDIS_URL=local',
  '# @option remoto @danger',
  '# REDIS_URL=remoto',
  '# @end',
].join('\n');

test('freio de mão reconhece comandos perigosos e ignora os seguros', () => {
  const p = DEFAULT_GUARD_PATTERNS;
  assert.ok(matchesGuard('npx prisma migrate dev', p));
  assert.ok(matchesGuard('npx  prisma   migrate   deploy', p));
  assert.ok(matchesGuard('pnpm prisma migrate reset --force', p));
  assert.ok(matchesGuard('npx prisma db push', p));
  assert.ok(matchesGuard('NPX PRISMA MIGRATE DEV', p));
  assert.ok(matchesGuard('npm run typeorm migration:run', p));
  assert.ok(!matchesGuard('npx prisma migrate status', p));
  assert.ok(!matchesGuard('npx prisma generate', p));
  assert.ok(!matchesGuard('npm run start:dev', p));
  assert.ok(!matchesGuard('', p));
});

test('padrão inválido na configuração é ignorado sem quebrar', () => {
  assert.ok(!matchesGuard('npx prisma migrate dev', ['(abre-e-nao-fecha']));
  assert.ok(matchesGuard('npx prisma migrate dev', ['(abre-e-nao-fecha', 'migrate']));
});

test('reconhece o comando do servidor no terminal', () => {
  assert.ok(commandMatches('npm run start:dev', 'npm run start:dev'));
  assert.ok(commandMatches('  npm   run start:dev -- --watch ', 'npm run start:dev'));
  assert.ok(!commandMatches('npm run start', 'npm run start:dev'));
  assert.ok(!commandMatches('npm run start:dev', ''));
});

test('activeDangers lista só as opções remotas ativas', () => {
  const d = activeDangers(parseEnv(ENV));
  assert.deepEqual(
    d.map((x) => `${x.group.name}:${x.option.name}`),
    ['Banco principal:homolog', 'API do Estoque:homolog'],
  );
  assert.deepEqual(activeDangers(undefined), []);
});

test('safeOption prefere "local" e nunca escolhe @danger', () => {
  const r = parseEnv(ENV);
  assert.equal(safeOption(r.groups[0])?.name, 'local');
  const onlyDanger = parseEnv('# @group X\n# @option a @danger\nA=1\n# @end');
  assert.equal(safeOption(onlyDanger.groups[0]), undefined);
});

test('voltar tudo pra local mexe só nos grupos remotos', () => {
  const r = parseEnv(ENV);
  const plan = planAllLocal(ENV, r);
  assert.deepEqual(plan.changed, [
    { group: 'Banco principal', from: 'homolog', to: 'local' },
    { group: 'API do Estoque', from: 'homolog', to: 'local' },
  ]);
  const out = applyEdits(ENV, plan.edits);
  const after = parseEnv(out);
  assert.deepEqual(activeDangers(after), []);
  assert.ok(after.groups.every((g) => g.state === 'valid'));
  // O grupo Cache (já local) não muda.
  assert.equal(splitLines(out)[16], 'REDIS_URL=local');
  // Rodar de novo não muda nada.
  assert.equal(planAllLocal(out, after).edits.length, 0);
});

test('voltar tudo pra local pula grupo sem opção segura', () => {
  const text = '# @group X\n# @option a @danger\nA=1\n# @option b @danger\n# A=2\n# @end';
  const plan = planAllLocal(text, parseEnv(text));
  assert.deepEqual(plan.skipped, ['X']);
  assert.equal(plan.edits.length, 0);
});

test('gerenciador de pacotes e scripts de dev', () => {
  assert.equal(detectPackageManager(['package.json', 'pnpm-lock.yaml']), 'pnpm');
  assert.equal(detectPackageManager(['yarn.lock']), 'yarn');
  assert.equal(detectPackageManager(['package-lock.json']), 'npm');
  assert.equal(scriptCommand('npm', 'start:dev'), 'npm run start:dev');
  assert.equal(scriptCommand('pnpm', 'dev'), 'pnpm dev');
  assert.deepEqual(
    rankDevScripts({ build: 'tsc', start: 'node dist', 'start:dev': 'nest start --watch', prestart: 'x', dev: 'vite' }).slice(0, 3),
    ['start:dev', 'dev', 'start'],
  );
});

import { hasLockfile, packageScripts } from '../src/logic';

test('script "start" vira "npm start"; os demais continuam "npm run <script>"', () => {
  assert.equal(scriptCommand('npm', 'start'), 'npm start');
  assert.equal(scriptCommand('npm', 'start:dev'), 'npm run start:dev');
  assert.equal(scriptCommand('npm', 'dev'), 'npm run dev');
  assert.equal(scriptCommand('pnpm', 'start'), 'pnpm start');
  assert.equal(scriptCommand('yarn', 'start'), 'yarn start');
  assert.equal(scriptCommand('bun', 'start'), 'bun run start');
  assert.equal(detectPackageManager(['package.json']), 'npm');
});

test('terminal com "npm run start" é reconhecido como "npm start", sem confundir com start:dev', () => {
  assert.ok(commandMatches('npm run start', 'npm start'));
  assert.ok(commandMatches('npm start', 'npm run start'));
  assert.ok(commandMatches('npm   start --verbose', 'npm start'));
  assert.equal(commandMatches('npm run start:dev', 'npm start'), false);
  assert.equal(commandMatches('npm run start-prod', 'npm start'), false);
  assert.ok(commandMatches('npm run start:dev', 'npm run start:dev'));
});

test('lockfile e scripts do package.json', () => {
  assert.ok(hasLockfile(['package.json', 'yarn.lock']));
  assert.ok(hasLockfile(['package-lock.json']));
  assert.equal(hasLockfile(['package.json', 'tsconfig.json']), false);
  assert.deepEqual(packageScripts({ scripts: { dev: 'vite', bad: 1, start: 'node .' } }), { dev: 'vite', start: 'node .' });
  assert.deepEqual(packageScripts({ name: 'x' }), {});
  assert.deepEqual(packageScripts(null), {});
  assert.deepEqual(packageScripts({ scripts: 'nope' }), {});
});

import { normalizeServices, serviceId, serviceUsesEnvDir, classifyPackage, guessPort, localPortRefs } from '../src/logic';

test('serviços: normaliza a configuração e ignora entradas inválidas', () => {
  const s = normalizeServices([
    { system: 'Loja', name: 'back', cwd: 'loja-api', command: 'npm run start:dev', port: 3000 },
    { system: 'Loja', name: 'back', command: 'duplicado' },
    { name: 'front', command: 'npm run dev', port: 99999 },
    { system: 'X', command: 'sem nome' },
    'lixo',
  ]);
  assert.deepEqual(s.map(serviceId), ['Loja · back', 'Projeto · front']);
  assert.equal(s[1].port, undefined);
  assert.deepEqual(normalizeServices(undefined), []);
});

test('serviço lê o .env só da própria pasta', () => {
  assert.ok(serviceUsesEnvDir('C:\\Users\\p\\loja\\loja-api', 'c:/users/p/loja/loja-api/'));
  assert.ok(!serviceUsesEnvDir('/p/loja/loja-web', '/p/loja/loja-api'));
});

test('classifica back/front e adivinha a porta', () => {
  assert.equal(classifyPackage({ dependencies: { '@nestjs/core': '10' } }), 'back');
  assert.equal(classifyPackage({ devDependencies: { vite: '5' } }), 'front');
  assert.equal(classifyPackage({}), undefined);
  assert.equal(guessPort('back', {}, 'NODE_ENV=x\nPORT=3034\n'), 3034);
  assert.equal(guessPort('front', { devDependencies: { vite: '5' } }), 5173);
  assert.equal(guessPort(undefined, {}), undefined);
});

test('portas locais usadas pelas opções ativas', () => {
  const env = [
    'FRONTEND_URL=http://localhost:5173',
    '# @group API do Estoque',
    '# @option local',
    'ESTOQUE_API_URL=http://localhost:3034/api',
    '# @option homolog @danger',
    '# ESTOQUE_API_URL=http://10.0.0.10:3034/api',
    '# @end',
    '# @group Banco',
    '# @option local',
    'DATABASE_URL=postgresql://u:p@localhost:5432/db',
    '# @end',
  ].join('\n');
  const refs = localPortRefs(env, parseEnv(env));
  assert.deepEqual(refs.map((r) => `${r.key}:${r.port}`), ['ESTOQUE_API_URL:3034', 'DATABASE_URL:5432']);
});

import { TerminalInfo, pickRunningTerminal, pickStartTerminal } from '../src/logic';

const term = (o: Partial<TerminalInfo>): TerminalInfo => ({
  activity: 'unknown',
  home: false,
  ownedByOther: false,
  active: false,
  commandMatches: false,
  ...o,
});
const API = 'C:\\proj\\loja\\loja-api';
const APP = 'c:\\proj\\loja\\loja-app';

test('iniciar reaproveita o terminal livre na pasta do serviço em vez de abrir outro', () => {
  const terms = [
    term({ cwd: APP, activity: 'busy' }), // front rodando
    term({ cwd: 'c:/proj/loja/loja-api/', activity: 'idle' }), // o seu terminal dividido, parado
  ];
  assert.equal(pickStartTerminal(terms, API), 1);
});

test('iniciar não usa terminal ocupado, de outro serviço ou em outra pasta', () => {
  assert.equal(pickStartTerminal([term({ cwd: API, activity: 'busy' })], API), -1);
  assert.equal(pickStartTerminal([term({ cwd: API, activity: 'idle', ownedByOther: true })], API), -1);
  assert.equal(pickStartTerminal([term({ cwd: APP, activity: 'idle', home: true })], API), -1);
  assert.equal(pickStartTerminal([term({ activity: 'idle' })], API), -1); // pasta desconhecida
});

test('iniciar prefere o terminal do próprio serviço e, depois, um ocioso confirmado', () => {
  assert.equal(pickStartTerminal([term({ cwd: API, activity: 'idle' }), term({ home: true })], API), 1);
  assert.equal(pickStartTerminal([term({ cwd: API, activity: 'idle' }), term({ cwd: API })], API), 0);
});

test('porta aberta: acha o terminal onde o serviço está rodando', () => {
  const terms = [
    term({ cwd: API, activity: 'busy' }), // outro comando na mesma pasta (ex.: prisma studio)
    term({ cwd: API, activity: 'busy', commandMatches: true }), // npm run start:dev
  ];
  assert.equal(pickRunningTerminal(terms, API), 1);
  assert.equal(pickRunningTerminal([term({ cwd: API })], API), 0); // iniciado antes da extensão ativar
});

test('porta aberta sem terminal na pasta do serviço não é adotada', () => {
  assert.equal(pickRunningTerminal([term({ cwd: APP, activity: 'busy', commandMatches: true })], API), -1);
  assert.equal(pickRunningTerminal([term({ cwd: API, activity: 'idle' })], API), -1);
  assert.equal(pickRunningTerminal([term({ cwd: API, activity: 'busy', ownedByOther: true })], API), -1);
});
