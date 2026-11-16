# Semáforo Env

Troque de banco no `.env` com um clique, sem comentar e descomentar linha na mão.

![Demonstração](media/demo.gif)

O Semáforo Env organiza o seu `.env` em **grupos independentes**. Exemplo: banco principal em `teste` e API externa em `homolog`, ao mesmo tempo, cada um com o seu clique. A status bar funciona como um semáforo:

| Cor | Significado |
|---|---|
| 🟢 Verde | Tudo local |
| 🟡 Amarelo | Algum grupo está inconsistente (nenhuma ou mais de uma opção ativa) |
| 🔴 Vermelho | Uma opção marcada como remota (`@danger`) está ativa |

## Como funciona

Você marca o próprio `.env` com comentários. Nenhum arquivo extra é criado, então Prisma, `dotenv`, `tsx`, Docker e qualquer outra ferramenta continuam lendo o `.env` normal.

```env
# Variáveis comuns ficam fora dos grupos
JWT_SECRET=troque-isto

# @group Banco principal
# @option local
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app
# @option teste
# DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app_teste
# @option homolog @danger
# DATABASE_URL=postgresql://usuario:senha@homolog.exemplo:5432/app
# @end

# @group API externa
# @option local
API_URL=http://localhost:3001
# @option homolog @danger
# API_URL=https://homolog.exemplo/api
# @end
```

Clicou em `homolog`? A extensão comenta as linhas de `local`, descomenta as de `homolog`, salva o arquivo e pede confirmação antes, porque a opção é `@danger`.

### Sintaxe

| Marcador | Significado |
|---|---|
| `# @group <Nome>` | Abre um grupo |
| `# @option <nome>` | Abre uma opção dentro do grupo |
| `# @option <nome> @danger` | Opção remota: pede confirmação e deixa o semáforo vermelho |
| `# @end` | Fecha o grupo |

- Só linhas `CHAVE=valor` (ativas) e `# CHAVE=valor` (inativas) são alternadas.
- Uma opção pode ter várias variáveis (ex.: `HOST`, `PORT`, `USER`, `PASSWORD`, `DB`).
- Linhas vazias, comentários comuns e tudo que está fora dos grupos nunca são alterados.
- Se o arquivo tiver erro de sintaxe (ex.: grupo sem `# @end`), a extensão mostra a linha do erro e não altera nada.

## Uso

- **Barra lateral (ícone de semáforo):** clique na opção desejada.
- **Status bar:** mostra a opção ativa de cada grupo. Clique para trocar pelo menu rápido.
- **Ctrl+Shift+P → "Semáforo Env: Trocar perfil"** faz o mesmo pelo teclado.
- **Ctrl+Z** desfaz a troca, porque a alteração é uma edição normal do documento.
- Depois de trocar, **reinicie o servidor**: `node --watch`, `tsx watch` e afins não recarregam o `.env` sozinhos.

## Monorepo e `.env` em subpasta

- Se não houver `.env` na raiz e existir **um único** `.env` em subpastas, ele é usado automaticamente.
- Se houver vários, use o botão **Escolher arquivo .env** na barra lateral. A escolha fica salva nas configurações do workspace.

## Configurações

| Setting | Padrão | Descrição |
|---|---|---|
| `semaforoEnv.file` | `.env` | Caminho do arquivo, relativo à primeira pasta do workspace |
| `semaforoEnv.showRestartHint` | `true` | Mostra o lembrete para reiniciar o servidor depois da troca |

## Segurança

- Nenhuma requisição de rede.
- Nunca exibe nem registra valores de variáveis, só nomes de grupos, opções e chaves.
- **Não versione o `.env` real.** Versione um `.env.example` com os marcadores e valores falsos.

## Limitações conhecidas

- Controla um arquivo por workspace, sempre da primeira pasta em workspaces com várias pastas.
- Trocar o `.env` não reinicia o processo que já está rodando.

## Desenvolvimento

```bash
npm install
npm test          # compila e roda os testes do parser
npm run package   # gera o .vsix
```

F5 abre uma janela de teste já na pasta `sandbox/`.

## Licença

MIT · feito por [Arabella Dev](https://github.com/pedrogamadev)
