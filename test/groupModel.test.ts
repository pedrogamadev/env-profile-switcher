import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseEnv } from '../src/parser';
import {
  GroupModel,
  activeValues,
  applyGroupModel,
  groupRefs,
  groupTableMarkdown,
  looseKeys,
  maskValue,
  mergeLoose,
  modelFromGroup,
  modelFromLoose,
  renderGroup,
  validateModel,
} from '../src/groupModel';

const GROUPED = [
  'JWT_SECRET=troque-isto',
  '',
  '# @group Banco principal',
  '# @option local',
  'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app',
  '# @option teste',
  '# DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app_teste',
  '# @option homolog @danger',
  '# DATABASE_URL=postgresql://usuario:senha@homolog.exemplo:5432/app',
  '# @end',
  '',
].join('\n');

const LOOSE = [
  'PORT=3000',
  'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app',
  '# DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app_teste',
  '#Homolog',
  '# DATABASE_URL=postgresql://usuario:senha@10.0.0.12:5432/app',
  'JWT_SECRET=troque-isto',
  '',
].join('\n');

function group(text: string, name: string) {
  const g = parseEnv(text).groups.find((x) => x.name === name);
  assert.ok(g, `grupo ${name}`);
  return g;
}

test('tabela de um grupo existente: opções nas linhas, variáveis nas colunas', () => {
  const m = modelFromGroup(GROUPED, group(GROUPED, 'Banco principal'));
  assert.deepEqual(m.keys, ['DATABASE_URL']);
  assert.deepEqual(m.options.map((o) => o.name), ['local', 'teste', 'homolog']);
  assert.equal(m.active, 0);
  assert.equal(m.options[2].danger, true);
  assert.match(m.options[1].values.DATABASE_URL, /app_teste$/);
});

test('salvar a tabela sem mudanças não altera o arquivo', () => {
  const m = modelFromGroup(GROUPED, group(GROUPED, 'Banco principal'));
  assert.equal(applyGroupModel(GROUPED, m, 'Banco principal').text, GROUPED);
});

test('trocar a opção ativa pela tabela comenta e descomenta as linhas certas', () => {
  const m = modelFromGroup(GROUPED, group(GROUPED, 'Banco principal'));
  m.active = 1;
  const { text } = applyGroupModel(GROUPED, m, 'Banco principal');
  const g = group(text, 'Banco principal');
  assert.equal(g.state, 'valid');
  assert.equal(g.options.find((o) => o.state === 'active')?.name, 'teste');
  assert.match(text, /\n# DATABASE_URL=postgresql:\/\/postgres:postgres@localhost:5432\/app\n/);
});

test('transformar variáveis soltas em seletor: nomes pelo endereço e pelo comentário, ativa preservada', () => {
  const m = modelFromLoose(LOOSE, ['DATABASE_URL']);
  assert.equal(m.name, 'Banco');
  assert.deepEqual(m.options.map((o) => o.name), ['local', 'teste', 'homolog']);
  assert.deepEqual(m.options.map((o) => o.danger), [false, false, true]);
  assert.equal(m.options[m.active].name, 'local');

  const r = applyGroupModel(LOOSE, m);
  assert.equal(r.moved, 3);
  const lines = r.text.split('\n');
  assert.equal(lines[0], 'PORT=3000');
  assert.equal(lines[1], '# @group Banco');
  assert.ok(!r.text.includes('#Homolog'), 'o comentário que só dizia o ambiente sai');
  assert.ok(r.text.includes('JWT_SECRET=troque-isto'));
  assert.equal(group(r.text, 'Banco').state, 'valid');
  assert.deepEqual(activeValues(r.text, ['DATABASE_URL']), activeValues(LOOSE, ['DATABASE_URL']), 'nenhum valor ativo muda');
});

test('adicionar coluna traz os valores soltos dela para as opções de mesmo nome', () => {
  const text = GROUPED + 'DIRECT_URL=postgresql://postgres:postgres@localhost:5432/app\n# DIRECT_URL=postgresql://u:s@homolog.exemplo:5432/app\n';
  const m = modelFromGroup(text, group(text, 'Banco principal'));
  assert.equal(mergeLoose(m, text, ['DIRECT_URL']), 2);
  assert.deepEqual(m.keys, ['DATABASE_URL', 'DIRECT_URL']);
  assert.ok(m.options[0].values.DIRECT_URL?.includes('localhost'), 'local recebe o valor local');
  assert.ok(m.options[2].values.DIRECT_URL?.includes('homolog'), 'homolog recebe o valor de homolog');
  assert.equal(m.options[1].values.DIRECT_URL, undefined);

  const r = applyGroupModel(text, m, 'Banco principal');
  assert.equal(r.moved, 2);
  assert.equal(r.text.split('\n').filter((l) => l.includes('DIRECT_URL')).length, 2, 'as linhas soltas foram para dentro do grupo');
  assert.equal(group(r.text, 'Banco principal').options[0].keys.join(','), 'DATABASE_URL,DIRECT_URL');
});

test('tirar uma coluna mantém a variável no .env com o valor da opção ativa', () => {
  const text = [
    '# @group Banco',
    '# @option local',
    'DATABASE_URL=postgresql://localhost/app',
    'SHADOW=postgresql://localhost/shadow',
    '# @option homolog @danger',
    '# DATABASE_URL=postgresql://homolog.exemplo/app',
    '# SHADOW=postgresql://homolog.exemplo/shadow',
    '# @end',
  ].join('\n');
  const m = modelFromGroup(text, group(text, 'Banco'));
  m.keys = ['DATABASE_URL'];
  const r = applyGroupModel(text, m, 'Banco');
  assert.deepEqual(r.released, ['SHADOW']);
  assert.ok(r.text.endsWith('# @end\nSHADOW=postgresql://localhost/shadow'));
});

test('grupo novo sem linhas soltas vai para o fim do arquivo', () => {
  const m: GroupModel = {
    name: 'Fila',
    keys: ['QUEUE_URL'],
    options: [
      { name: 'local', danger: false, values: { QUEUE_URL: 'amqp://localhost' } },
      { name: 'homolog', danger: true, values: { QUEUE_URL: 'amqp://homolog.exemplo' } },
    ],
    active: 0,
  };
  const r = applyGroupModel('PORT=3000\n', m);
  assert.equal(r.text, 'PORT=3000\n\n' + renderGroup(m).join('\n') + '\n');
  assert.equal(group(r.text, 'Fila').state, 'valid');
});

test('validação explica o que falta em português', () => {
  const m: GroupModel = {
    name: '',
    keys: ['DATABASE_URL', '1X'],
    options: [
      { name: 'local', danger: false, values: { DATABASE_URL: 'a' } },
      { name: 'local', danger: false, values: {} },
    ],
    active: -1,
  };
  const errors = validateModel(m, groupRefs(GROUPED));
  assert.ok(errors.some((e) => e.includes('nome ao grupo')));
  assert.ok(errors.some((e) => e.includes('"1X"')));
  assert.ok(errors.some((e) => e.includes('já pertence ao grupo "Banco principal"')));
  assert.ok(errors.some((e) => e.includes('duas opções chamadas "local"')));
  assert.ok(errors.some((e) => e.includes('não define nenhuma variável')));
  assert.ok(errors.some((e) => e.includes('fica ativa')));
  const ok = modelFromGroup(GROUPED, group(GROUPED, 'Banco principal'));
  assert.deepEqual(validateModel(ok, groupRefs(GROUPED).filter((g) => g.name !== 'Banco principal')), []);
});

test('valores mascarados não mostram usuário, senha nem segredos', () => {
  assert.equal(maskValue('DATABASE_URL', 'postgresql://user:s3nha@db.exemplo:5432/app?schema=public'), 'db.exemplo:5432/app');
  assert.equal(maskValue('DATABASE_URL', '"postgresql://u:p@localhost:5432/app"'), 'localhost:5432/app');
  assert.equal(maskValue('JWT_SECRET', 'abc123'), '••••••');
  assert.equal(maskValue('API_KEY', 'abc'), '••••••');
  assert.equal(maskValue('NODE_ENV', 'development'), 'development');
  assert.equal(maskValue('X', '   '), '(vazio)');
});

test('maskValue funciona sozinho (é injetado no editor em tabela)', () => {
  const standalone = new Function(`return (${maskValue.toString()})`)() as typeof maskValue;
  assert.equal(standalone('DATABASE_URL', 'postgresql://u:p@host:1/db'), 'host:1/db');
});

test('tabela em markdown escapa o conteúdo', () => {
  const m = modelFromGroup(GROUPED, group(GROUPED, 'Banco principal'));
  m.options[1].name = 'a|b';
  const md = groupTableMarkdown(m);
  assert.ok(md.includes('a\\|b'));
  assert.ok(md.includes('● | local'));
  assert.ok(!md.includes('senha'));
});

test('variáveis soltas sugeridas como colunas', () => {
  assert.deepEqual(looseKeys(GROUPED), ['JWT_SECRET']);
  assert.deepEqual(looseKeys(LOOSE), ['DATABASE_URL', 'JWT_SECRET', 'PORT']);
});

test('arquivo com CRLF continua com CRLF', () => {
  const crlf = LOOSE.replace(/\n/g, '\r\n');
  const r = applyGroupModel(crlf, modelFromLoose(crlf, ['DATABASE_URL']));
  assert.ok(!/[^\r]\n/.test(r.text));
});

test('coluna nova casa pelo servidor quando o nome da opção não bate', () => {
  const text = LOOSE + 'DIRECT_URL=postgresql://postgres:postgres@localhost:5432/app\n# DIRECT_URL=postgresql://usuario:senha@10.0.0.12:5432/app\n';
  const m = modelFromLoose(text, ['DATABASE_URL']);
  assert.equal(mergeLoose(m, text, ['DIRECT_URL']), 2);
  assert.deepEqual(m.options.map((o) => o.name), ['local', 'teste', 'homolog'], 'não cria "rede-interna"');
  assert.ok(m.options[2].values.DIRECT_URL?.includes('10.0.0.12'));
});
