import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseEnv, splitLines } from '../src/parser';
import { proposeOrganization, describeProposal, hostOf, labelFromComment, groupNameFor } from '../src/organize';

const assignments = (t: string) =>
  splitLines(t)
    .filter((l) => /^\s*#?\s?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l))
    .sort();

function check(original: string) {
  const p = proposeOrganization(original);
  const parsed = parseEnv(p.newText);
  assert.deepEqual(parsed.errors, [], 'texto organizado tem erro de sintaxe');
  assert.deepEqual(assignments(p.newText), assignments(original), 'alguma linha de variável mudou ou sumiu');
  return { p, parsed };
}

test('Catálogo Fácil: banco local x supabase, com DIRECT_URL junto do supabase', () => {
  const env = [
    'NODE_ENV=development',
    'PORT=3000',
    '#DATABASE_URL=postgresql://postgres:6562@localhost:5432/cardapio-app',
    'DATABASE_URL=postgresql://postgres.abc:senha@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true',
    'DIRECT_URL=postgresql://postgres.abc:senha@aws-0-us-west-2.pooler.supabase.com:5432/postgres',
    '',
    'JWT_SECRET=x',
  ].join('\n');
  const { p, parsed } = check(env);
  assert.deepEqual(describeProposal(p), ['Banco: local, supabase (remoto)']);
  const g = parsed.groups[0];
  assert.deepEqual(g.options.find((o) => o.name === 'supabase')!.keys, ['DATABASE_URL', 'DIRECT_URL']);
  assert.equal(g.options.find((o) => o.name === 'supabase')!.state, 'active');
  assert.equal(splitLines(p.newText)[0], 'NODE_ENV=development');
});

test('Loja: rótulos vindos de comentários, IP interno vira remoto, dois grupos separados', () => {
  const env = [
    'NODE_ENV=development',
    '#local',
    '#DATABASE_URL=postgresql://postgres:postgres@localhost:5432/loja',
    'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/loja_validacao',
    '#Homolog',
    '#DATABASE_URL=postgresql://loja:senha@10.0.0.10:5450/loja',
    '',
    '# API de estações de trabalho (homolog)',
    'ESTOQUE_API_URL=http://10.0.0.10:3034/api',
    '# API de estações de trabalho (local)',
    '#ESTOQUE_API_URL=http://localhost:3034/api',
    'PORT=3000',
  ].join('\n');
  const { p, parsed } = check(env);
  assert.deepEqual(describeProposal(p), [
    'Banco: local, teste, homolog (remoto)',
    'Estoque api: local, homolog (remoto)',
  ]);
  assert.equal(p.removedComments.length, 4);
  assert.equal(parsed.groups[0].options.find((o) => o.name === 'teste')!.state, 'active');
  assert.equal(parsed.groups[1].options.find((o) => o.name === 'homolog')!.state, 'active');
  assert.ok(p.newText.includes('PORT=3000'));
});

test('variáveis que mudam juntas viram um grupo só', () => {
  const env = [
    'DATABASE_ESTOQUE=postgresql://u:p@localhost:5432/estoque',
    'ESTOQUE_API_URL=http://localhost:3001',
    '#DATABASE_ESTOQUE=postgresql://u:p@homolog.exemplo:5432/estoque',
    '#ESTOQUE_API_URL=https://homolog.exemplo/api',
  ].join('\n');
  const { p } = check(env);
  assert.equal(p.groups.length, 1);
  assert.deepEqual(p.groups[0].options.map((o) => [o.name, o.lines.length, o.danger]), [
    ['local', 2, false],
    ['homolog', 2, true],
  ]);
});

test('valores que não são URL usam o próprio valor como nome', () => {
  const env = 'NODE_ENV=development\n#NODE_ENV=production\n';
  const { p } = check(env);
  assert.deepEqual(describeProposal(p), ['Ambiente: development, production (remoto)']);
});

test('arquivo já organizado não gera proposta', () => {
  const env = 'A=1\n#DATABASE_URL=postgresql://localhost/a\nDATABASE_URL=postgresql://db.supabase.co/a\n';
  const once = proposeOrganization(env).newText;
  const again = proposeOrganization(once);
  assert.equal(again.groups.length, 0);
  assert.equal(again.newText, once);
});

test('sem alternativas, nada muda', () => {
  const env = 'A=1\nB=2\n';
  assert.equal(proposeOrganization(env).newText, env);
});

test('preserva CRLF', () => {
  const env = '#DATABASE_URL=postgresql://localhost/a\r\nDATABASE_URL=postgresql://x.neon.tech/a\r\nB=1\r\n';
  const p = proposeOrganization(env);
  assert.ok(!/[^\r]\n/.test(p.newText));
  assert.deepEqual(describeProposal(p), ['Banco: local, neon (remoto)']);
});

test('seleção manual junta as linhas escolhidas num grupo com o nome dado', () => {
  const env = ['A=1', 'STORAGE_BUCKET=dev-bucket', '#STORAGE_BUCKET=prod-bucket', 'B=2'].join('\n');
  const p = proposeOrganization(env, { onlyLines: new Set([1, 2]), groupName: 'Storage' });
  assert.deepEqual(describeProposal(p), ['Storage: dev-bucket, prod-bucket (remoto)']);
  assert.deepEqual(parseEnv(p.newText).errors, []);
});

test('helpers', () => {
  assert.equal(hostOf('postgresql://u:p@LOCALHOST:5432/db'), 'localhost');
  assert.equal(hostOf('"https://api.x.com/v1"'), 'api.x.com');
  assert.equal(hostOf('abc'), undefined);
  assert.equal(labelFromComment('#Homolog'), 'homolog');
  assert.equal(labelFromComment('# API de estações de trabalho (local)'), 'local');
  assert.equal(labelFromComment('# Base do back_url da assinatura do Mercado Pago'), undefined);
  assert.equal(groupNameFor(['REDIS_URL']), 'Redis');
  assert.equal(groupNameFor(['PAYMENTS_API_URL']), 'Payments api');
});

test('arquivo com erro de sintaxe não é organizado', () => {
  assert.throws(() => proposeOrganization('# @group X\nA=1'), /Linha/);
});
