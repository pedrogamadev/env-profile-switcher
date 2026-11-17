import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parseEnv,
  computeSelection,
  applyEdits,
  activateLine,
  deactivateLine,
  splitLines,
} from '../src/parser';
import { EXAMPLE_ENV } from '../src/example';

const EXAMPLE = [
  '# comum',
  'JWT_SECRET=abc',
  '# @group Banco principal',
  '# @option local',
  'DATABASE_URL=postgres://localhost/app',
  '# @option teste',
  '# DATABASE_URL=postgres://localhost/app_teste',
  '# @option homolog @danger',
  '# DATABASE_URL=postgres://homolog.exemplo/app',
  '# @end',
  '# @group Banco de consulta',
  '# @option local',
  'DATABASE_ESTOQUE=postgres://localhost/estoque',
  'ESTOQUE_API_URL=http://localhost:3001',
  '# @option homolog @danger',
  '# DATABASE_ESTOQUE=postgres://homolog.exemplo/estoque',
  '# ESTOQUE_API_URL=https://homolog.exemplo/api',
  '# @end',
  '',
].join('\n');

function select(text: string, group: string, option: string): string {
  return applyEdits(text, computeSelection(text, group, option).edits);
}

test('parse do exemplo: grupos, estados e @danger', () => {
  const r = parseEnv(EXAMPLE);
  assert.deepEqual(r.errors, []);
  assert.equal(r.groups.length, 2);

  const [principal, consulta] = r.groups;
  assert.equal(principal.name, 'Banco principal');
  assert.equal(principal.state, 'valid');
  assert.deepEqual(
    principal.options.map((o) => [o.name, o.state, o.danger]),
    [
      ['local', 'active', false],
      ['teste', 'inactive', false],
      ['homolog', 'inactive', true],
    ],
  );

  assert.equal(consulta.name, 'Banco de consulta');
  assert.equal(consulta.state, 'valid');
  assert.deepEqual(consulta.options[0].keys, ['DATABASE_ESTOQUE', 'ESTOQUE_API_URL']);
  assert.equal(consulta.options[1].danger, true);
});

test('trocar local -> homolog no grupo 1 altera só o grupo 1', () => {
  const sel = computeSelection(EXAMPLE, 'Banco principal', 'homolog');
  const touched = sel.edits.map((e) => e.line).sort((a, b) => a - b);
  assert.deepEqual(touched, [4, 8]);

  const out = applyEdits(EXAMPLE, sel.edits);
  const before = splitLines(EXAMPLE);
  const after = splitLines(out);
  assert.equal(after[4], '# DATABASE_URL=postgres://localhost/app');
  assert.equal(after[8], 'DATABASE_URL=postgres://homolog.exemplo/app');
  for (let i = 0; i < before.length; i++) {
    if (i !== 4 && i !== 8) assert.equal(after[i], before[i], `linha ${i} mudou`);
  }

  const r = parseEnv(out);
  assert.equal(r.groups[0].options[2].state, 'active');
  assert.equal(r.groups[1].options[0].state, 'active');
});

test('aplicar a mesma seleção duas vezes é idempotente', () => {
  const once = select(EXAMPLE, 'Banco de consulta', 'homolog');
  const twice = select(once, 'Banco de consulta', 'homolog');
  assert.equal(twice, once);
  assert.equal(computeSelection(once, 'Banco de consulta', 'homolog').edits.length, 0);
});

test('ida e volta devolve o arquivo original', () => {
  const ida = select(EXAMPLE, 'Banco principal', 'teste');
  const volta = select(ida, 'Banco principal', 'local');
  assert.equal(volta, EXAMPLE);
});

test('preserva CRLF', () => {
  const crlf = EXAMPLE.replace(/\n/g, '\r\n');
  const out = select(crlf, 'Banco principal', 'teste');
  assert.ok(!/[^\r]\n/.test(out), 'apareceu LF solto');
  assert.equal(out.split('\r\n').length, crlf.split('\r\n').length);
  assert.ok(out.includes('\r\nDATABASE_URL=postgres://localhost/app_teste\r\n'));
});

test('preserva comentário inline, aspas e indentação', () => {
  const line = '  KEY="a b" # comentario';
  assert.equal(deactivateLine(line), '  # KEY="a b" # comentario');
  assert.equal(activateLine(deactivateLine(line)), line);
  assert.equal(activateLine('#KEY=1'), 'KEY=1');
  assert.equal(activateLine('# KEY=valor#com#cerquilha'), 'KEY=valor#com#cerquilha');
});

test('grupo com duas opções ativas é inconsistente', () => {
  const text = [
    '# @group DB',
    '# @option a',
    'URL=a',
    '# @option b',
    'URL=b',
    '# @end',
  ].join('\n');
  const r = parseEnv(text);
  assert.deepEqual(r.errors, []);
  assert.equal(r.groups[0].state, 'inconsistent');

  // Selecionar resolve a inconsistência.
  const fixed = select(text, 'DB', 'b');
  assert.equal(parseEnv(fixed).groups[0].state, 'valid');
});

test('opção com linhas misturadas é "mixed" e deixa o grupo inconsistente', () => {
  const text = [
    '# @group DB',
    '# @option a',
    'URL=a',
    '# PORT=1',
    '# @option b',
    '# URL=b',
    '# @end',
  ].join('\n');
  const r = parseEnv(text);
  assert.equal(r.groups[0].options[0].state, 'mixed');
  assert.equal(r.groups[0].state, 'inconsistent');
});

test('@option fora de grupo gera erro com a linha correta', () => {
  const text = ['A=1', '', '# @option perdido', 'B=2'].join('\n');
  const r = parseEnv(text);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 2);
  assert.match(r.errors[0].message, /fora de um "@group"/);
});

test('grupo sem @end gera erro e bloqueia a seleção', () => {
  const text = ['# @group DB', '# @option a', 'URL=a', '# @option b', '# URL=b'].join('\n');
  const r = parseEnv(text);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /falta "# @end"/);
  assert.throws(() => computeSelection(text, 'DB', 'b'), /Linha 1:/);
});

test('linha vazia e comentário comum dentro do bloco ficam intactos', () => {
  const text = [
    '# @group DB',
    '# @option a',
    '# banco da minha máquina',
    'URL=a',
    '',
    '# @option b',
    '# só funciona na VPN',
    '# URL=b',
    '# @end',
  ].join('\n');
  const out = select(text, 'DB', 'b');
  const lines = splitLines(out);
  assert.equal(lines[2], '# banco da minha máquina');
  assert.equal(lines[4], '');
  assert.equal(lines[6], '# só funciona na VPN');
  assert.equal(lines[3], '# URL=a');
  assert.equal(lines[7], 'URL=b');
});

test('linhas fora de grupos nunca são tocadas', () => {
  const text = ['# KEY_FORA=1', 'OUTRA=2', EXAMPLE].join('\n');
  const out = select(text, 'Banco principal', 'teste');
  const lines = splitLines(out);
  assert.equal(lines[0], '# KEY_FORA=1');
  assert.equal(lines[1], 'OUTRA=2');
});

test('variável antes do primeiro @option é erro', () => {
  const text = ['# @group DB', 'URL=x', '# @option a', 'URL=a', '# @end'].join('\n');
  const r = parseEnv(text);
  assert.equal(r.errors[0].line, 1);
});

test('nomes duplicados geram erro', () => {
  const text = [
    '# @group DB',
    '# @option a',
    'URL=a',
    '# @option a',
    '# URL=b',
    '# @end',
  ].join('\n');
  assert.match(parseEnv(text).errors[0].message, /duplicada/);
});

test('@danger só conta como último token e não entra no nome', () => {
  const text = [
    '# @group DB',
    '# @option homolog cliente @danger',
    'URL=a',
    '# @option @danger local',
    '# URL=b',
    '# @end',
  ].join('\n');
  const [a, b] = parseEnv(text).groups[0].options;
  assert.equal(a.name, 'homolog cliente');
  assert.equal(a.danger, true);
  assert.equal(b.name, '@danger local');
  assert.equal(b.danger, false);
});

test('o .env.example embutido na extensão é válido', () => {
  const r = parseEnv(EXAMPLE_ENV);
  assert.deepEqual(r.errors, []);
  assert.equal(r.groups.length, 2);
  assert.ok(r.groups.every((g) => g.state === 'valid'));
});
