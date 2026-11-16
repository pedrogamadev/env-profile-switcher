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
  '# @group API do Controle',
  '# @option local',
  '# CONTROLE_API_URL=local',
  '# @option homolog @danger',
  'CONTROLE_API_URL=homolog',
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
    ['Banco principal:homolog', 'API do Controle:homolog'],
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
    { group: 'API do Controle', from: 'homolog', to: 'local' },
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

import { normalizeServices, serviceId, serviceUsesEnvDir, classifyPackage, guessPort, localPortRefs } from '../src/logic';

test('serviços: normaliza a configuração e ignora entradas inválidas', () => {
  const s = normalizeServices([
    { system: 'SGC', name: 'back', cwd: 'sgc-api', command: 'npm run start:dev', port: 3000 },
    { system: 'SGC', name: 'back', command: 'duplicado' },
    { name: 'front', command: 'npm run dev', port: 99999 },
    { system: 'X', command: 'sem nome' },
    'lixo',
  ]);
  assert.deepEqual(s.map(serviceId), ['SGC · back', 'Projeto · front']);
  assert.equal(s[1].port, undefined);
  assert.deepEqual(normalizeServices(undefined), []);
});

test('serviço lê o .env só da própria pasta', () => {
  assert.ok(serviceUsesEnvDir('C:\\Users\\p\\sgc\\sgc-api', 'c:/users/p/sgc/sgc-api/'));
  assert.ok(!serviceUsesEnvDir('/p/sgc/sgc-web', '/p/sgc/sgc-api'));
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
    '# @group API do Controle',
    '# @option local',
    'CONTROLE_API_URL=http://localhost:3034/api',
    '# @option homolog @danger',
    '# CONTROLE_API_URL=http://10.26.0.51:3034/api',
    '# @end',
    '# @group Banco',
    '# @option local',
    'DATABASE_URL=postgresql://u:p@localhost:5432/db',
    '# @end',
  ].join('\n');
  const refs = localPortRefs(env, parseEnv(env));
  assert.deepEqual(refs.map((r) => `${r.key}:${r.port}`), ['CONTROLE_API_URL:3034', 'DATABASE_URL:5432']);
});
