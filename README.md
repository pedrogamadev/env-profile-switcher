# Env Profiles

Extensão do VS Code para alternar perfis de banco (ou qualquer conjunto de variáveis) no `.env` por **grupos independentes**, sem comentar e descomentar linha na mão.

Exemplo: banco principal em `homolog` e banco de consulta em `local`, ao mesmo tempo, com um clique em cada.

## Como funciona

A extensão lê marcadores no próprio `.env`, mostra os grupos numa view lateral e na status bar, e comenta/descomenta as linhas por você. Nenhum arquivo extra é criado, então Prisma CLI, `tsx`, Docker e qualquer outra ferramenta continuam lendo o `.env` normal.

```env
# Variáveis comuns
JWT_SECRET=troque-isto

# @group Banco principal
# @option local
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app
# @option teste
# DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app_teste
# @option homolog @danger
# DATABASE_URL=postgresql://usuario:senha@homolog.exemplo:5432/app
# @end

# @group Banco de consulta
# @option local
DATABASE_CONTROLE=postgresql://postgres:postgres@localhost:5432/controle
CONTROLE_API_URL=http://localhost:3001
# @option homolog @danger
# DATABASE_CONTROLE=postgresql://usuario:senha@homolog.exemplo:5432/controle
# CONTROLE_API_URL=https://homolog.exemplo/api
# @end
```

### Regras da sintaxe

| Marcador | Significado |
|---|---|
| `# @group <Nome>` | Abre um grupo |
| `# @option <nome>` | Abre uma opção dentro do grupo |
| `# @option <nome> @danger` | Opção perigosa (banco remoto): pede confirmação e deixa a status bar vermelha |
| `# @end` | Fecha o grupo |

- Só linhas `CHAVE=valor` (ativas) e `# CHAVE=valor` (inativas) são alternadas.
- Linhas vazias e comentários comuns dentro dos blocos nunca são alterados.
- Linhas fora de grupos nunca são alteradas.
- Cada grupo deve ter exatamente uma opção ativa. Se não tiver, aparece como **inconsistente** e basta escolher uma opção para corrigir.
- Se o arquivo tiver erro de sintaxe (ex.: grupo sem `# @end`), a extensão mostra a linha do erro e não altera nada.

## Uso

- **View lateral "Env Profiles"**: clique na opção desejada.
- **Status bar**: mostra a opção ativa de cada grupo. Clique para trocar via QuickPick. Fica vermelha quando uma opção `@danger` está ativa.
- **Ctrl+Z** desfaz a troca (a alteração é feita como edição normal do documento).
- Depois de trocar, **reinicie o servidor**: `node --watch` e `tsx watch` não recarregam o `.env` sozinhos.

## Configurações

| Setting | Padrão | Descrição |
|---|---|---|
| `envProfiles.file` | `.env` | Caminho do arquivo, relativo à primeira pasta do workspace |
| `envProfiles.showRestartHint` | `true` | Mostra o lembrete para reiniciar o servidor |

## Desenvolvimento

```bash
npm install
npm test          # compila e roda os testes do parser
npm run package   # gera o .vsix
```

F5 abre uma janela de teste já na pasta `sandbox/`.

## Instalação sem publicar

```bash
code --install-extension env-profile-switcher-0.1.0.vsix
```

Ou: Ctrl+Shift+P → **Extensions: Install from VSIX...**

## Segurança

- A extensão não faz nenhuma requisição de rede.
- Nunca exibe nem registra valores de variáveis, só nomes de grupos, opções e chaves.
- **Nunca versione o `.env` real.** Versione um `.env.example` com os marcadores e valores falsos.
