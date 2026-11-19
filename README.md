# Semáforo Env

**O hub do seu ambiente local.** Troque bancos e APIs do `.env` com um clique, suba e reinicie o front e o back de vários sistemas num painel só, e pare de rodar migration no lugar errado.

**[Instalar pelo VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=arabella-dev.semaforo-env)** · ou no VS Code: Ctrl+Shift+X → pesquise `Semáforo Env`

![Demonstração](media/demo.gif)

## O que ele resolve

| Antes | Com o Semáforo |
|---|---|
| Comentar e descomentar linhas do `.env` pra trocar de banco | Um clique na opção desejada |
| Aprender um formato novo pra organizar o `.env` | Uma tabela: opções nas linhas, variáveis nas colunas. O Semáforo grava o resto |
| Ctrl+C no terminal e subir o servidor de novo depois de cada troca | Os serviços que leem aquele `.env` reiniciam sozinhos |
| Abrir 6 terminais pra testar 3 sistemas que conversam entre si | Painel **Serviços** com ▶ ■ ⟳ por serviço, por sistema ou tudo de uma vez |
| Descobrir no log que a API local do outro sistema estava desligada | Aviso: "API do Estoque está em local, mas estoque · back está parado", com o botão **Iniciar** |
| Esquecer o homolog ligado | Status bar vermelha, aviso ao abrir o projeto e **🏠 Voltar tudo pra local** |
| Rodar `prisma migrate dev` apontando pro banco da equipe | **Freio de mão:** o comando é cancelado e o Semáforo pergunta antes |

## Começando em 2 minutos

1. **Monte os seletores:** abra o Semáforo na barra lateral. Se o seu `.env` já tem a mesma variável ativa e comentada (ex.: o banco local ativo e o de homolog comentado), ele mostra em **Encontrei no seu .env**: clique para revisar numa tabela e aplicar. Se não, use **Montar seletor em tabela**. Você não escreve marcador nenhum e nenhum valor muda.
2. **Detecte os serviços:** no painel **Serviços**, clique em **Detectar serviços**. O Semáforo lê os `package.json`, identifica o que é front e o que é back e sugere o comando e a porta de cada um.
3. **Use:** clique nas opções pra trocar de ambiente e nos botões pra subir os serviços. O resto é automático.

## Perfis do `.env`

Um **seletor** é uma variável (ou um conjunto delas) com mais de um valor possível, em que você escolhe qual está valendo. Pense numa tabela:

| | Opção | `DATABASE_URL` | `DIRECT_URL` |
|:-:|---|---|---|
| ● | local | localhost:5432/app | localhost:5432/app |
| ○ | teste | localhost:5432/app_teste | — |
| ○ | homolog *(remoto)* | 10.0.0.12:5432/app | 10.0.0.12:5432/app |

- Cada **linha** é uma opção. Cada **coluna** é uma variável que o sistema lê.
- Só a opção **ativa** fica descomentada no `.env`. As outras ficam guardadas como comentário, e trocar é um clique.
- **Remoto** pede confirmação antes de ativar e deixa o semáforo vermelho.
- Cada seletor é independente: banco em `teste` e API do outro sistema em `homolog` ao mesmo tempo.

Tudo fica no próprio `.env`, então Prisma, `dotenv`, `tsx` e Docker continuam lendo o arquivo normal.

### Três jeitos de criar, sem escrever marcador nenhum

1. **Pelo painel:** se o `.env` já tem a mesma variável ativa e comentada, o painel mostra em **Encontrei no seu .env**. Clique numa sugestão para revisar em tabela, ou use a varinha para transformar todas de uma vez.
2. **No próprio `.env`:** acima dessas linhas aparece **DATABASE_URL tem 3 valores · Transformar em seletor**. Nos seletores prontos aparecem **Trocar** e **Editar em tabela**, e passar o mouse num marcador mostra a tabela daquele seletor.
3. **Do zero:** botão **+** no painel (ou **Semáforo Env: Novo seletor em tabela**). Adicione as variáveis como colunas: os valores que já estão no `.env` entram sozinhos na tabela.

O editor em tabela mostra os valores sem usuário e senha (só host, porta e banco) até você pedir os valores completos, e sempre mostra o antes e depois do `.env` antes de gravar. Se a opção ativa mudar, os serviços que leem aquele `.env` reiniciam como numa troca normal.

Outros atalhos: **Organizar .env automaticamente** dá nome às opções pelo endereço (`localhost` vira **local**, um host com "homolog" vira **homolog**, um IP da rede interna vira **rede-interna**...) ou por um comentário curto logo acima da linha (`#Homolog`). Também dá pra selecionar linhas no editor → botão direito → **Criar grupo com as linhas selecionadas**.

### Por baixo dos panos

A tabela é gravada no `.env` com quatro marcadores em comentário. Dá pra ler e editar à mão, mas você não precisa:

```env
# @group Banco
# @option local
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app
DIRECT_URL=postgresql://postgres:postgres@localhost:5432/app
# @option supabase @danger
# DATABASE_URL=postgresql://usuario:senha@db.supabase.co:6543/postgres
# DIRECT_URL=postgresql://usuario:senha@db.supabase.co:5432/postgres
# @end

# @group API do Estoque
# @option local
ESTOQUE_API_URL=http://localhost:3034/api
# @option homolog @danger
# ESTOQUE_API_URL=https://homolog.exemplo/api
# @end
```

| Marcador | Significado |
|---|---|
| `# @group <Nome>` | Abre um grupo |
| `# @option <nome>` | Abre uma opção dentro do grupo |
| `# @option <nome> @danger` | Opção remota: pede confirmação e deixa o semáforo vermelho |
| `# @end` | Fecha o grupo |

- Só linhas `CHAVE=valor` (ativas) e `# CHAVE=valor` (inativas) são alternadas. Comentários comuns e tudo que está fora dos grupos ficam intactos.
- Uma opção pode ter várias variáveis (ex.: `DATABASE_URL` + `DIRECT_URL`, ou `HOST`, `PORT`, `USER`...).
- Se o arquivo tiver erro de sintaxe, a extensão mostra a linha e não altera nada.
- **Ctrl+Z** desfaz qualquer troca.

## Serviços

O painel **Serviços** mostra cada front e back com um semáforo próprio:

| Bolinha | Estado |
|---|---|
| 🟢 | Rodando (a porta respondeu) |
| 🟡 | Iniciando |
| ⚪ | Parado |
| 🔴 | Caiu (o processo terminou com erro) |

- **▶ ■ ⟳** por serviço, **▶** por sistema (sobe o back antes do front) e **Iniciar/Parar todos** no topo.
- Cada serviço roda num **terminal visível**. Ao iniciar, o Semáforo reaproveita o terminal do serviço ou um terminal seu que esteja parado na pasta dele (dividido ou não). Se precisar abrir um novo (`loja · back`, `loja · front`...), ele abre **dividido** ao lado do outro serviço do mesmo sistema. Clique no serviço pra ver os logs.
- **Reinício certeiro:** ao trocar um `.env`, só reiniciam os serviços que rodam na pasta daquele `.env`. O front não reinicia quando você troca o banco do back.
- **Dependências:** se uma opção ativa aponta pra `localhost:PORTA` e o serviço daquela porta está parado, o painel avisa e oferece **Iniciar**.
- **Adota o que você já roda:** se você mesmo rodar `npm run dev` num terminal, na pasta de um serviço configurado, o painel reconhece e passa a controlar aquele terminal. Com o painel aberto, ele também confere a porta a cada poucos segundos: porta respondendo com um terminal na pasta do serviço vira "rodando", mesmo que o início tenha passado despercebido.
- **Porta ocupada:** antes de iniciar, o Semáforo avisa se a porta já está em uso por outro processo.

## Vários sistemas juntos (ecossistema)

Pra testar sistemas que conversam entre si (ex.: Estoque, Loja e Pagamentos, cada um com front e back), abra todos numa janela só com um **workspace de várias pastas**:

1. No painel **Serviços** (menu **⋯**), use **Criar workspace do ecossistema** e escolha as pastas dos sistemas.
2. Abra o workspace criado.
3. Clique em **Detectar serviços**.

Cada sistema passa a ter o **seu** `.env` no painel **Perfis**, e a status bar resume todos (ex.: `loja: homolog · estoque · pagamentos`). Os serviços ficam salvos no próprio arquivo `.code-workspace`, então dá pra versionar e a equipe inteira ganha o mesmo painel:

```json
{
  "folders": [{ "path": "estoque" }, { "path": "loja" }, { "path": "pagamentos" }],
  "settings": {
    "semaforoEnv.services": [
      { "system": "loja", "name": "back", "folder": "loja", "cwd": "loja-api", "command": "npm run start:dev", "port": 3000 },
      { "system": "loja", "name": "front", "folder": "loja", "cwd": "loja-web", "command": "npm run dev", "port": 5174 }
    ]
  }
}
```

## Proteções

- **Status bar como semáforo:** verde quando tudo é local, amarela quando algum grupo está inconsistente, vermelha quando há opção `@danger` ativa.
- **Freio de mão:** com uma opção `@danger` ativa, `prisma migrate dev/deploy/reset`, `prisma db push/seed` e equivalentes de TypeORM, Sequelize e Knex são cancelados no terminal integrado. Você escolhe entre **Rodar mesmo assim** e **Voltar tudo pra local**.
- **Aviso ao abrir:** se o projeto abrir com opção remota ativa, o Semáforo avisa e volta tudo pra local com um clique.
- **🏠 Voltar tudo pra local:** leva todos os grupos de todos os sistemas pra opção segura e reinicia o que for preciso.

## Projeto com um servidor só

Sem o painel de serviços configurado, ainda dá pra reiniciar o servidor sozinho: **Ctrl+Shift+P → Semáforo Env: Configurar reinício automático**. O Semáforo reinicia o terminal onde o servidor está rodando (o seu) ou abre um terminal visível. Também funciona com tasks do VS Code e com a sessão de debug (F5).

O comando escolhido fica salvo **por pasta de projeto** (a pasta do `package.json`), no estado do workspace, e não no `settings.json`. Num projeto com `loja-api` e `loja-app`, cada um guarda o seu, e trocar o `.env` de `loja-api` reinicia só o servidor de `loja-api`. Para esquecer um comando salvo: **Semáforo Env: Redefinir comando de inicialização**.

## Configurações

| Setting | Padrão | Descrição |
|---|---|---|
| `semaforoEnv.file` | `.env` | `.env` controlado, relativo à pasta. Em workspaces de várias pastas, cada sistema tem o seu |
| `semaforoEnv.services` | `[]` | Serviços do painel: `system`, `name`, `folder`, `cwd`, `command`, `port` |
| `semaforoEnv.showRestartHint` | `true` | Lembrete pra reiniciar quando nada está configurado |
| `semaforoEnv.restart.*` | | **Obsoletas desde a 0.4.1.** O reinício simples agora fica no estado do workspace. Valores antigos são migrados uma vez e depois ignorados |
| `semaforoEnv.guard.enabled` | `true` | Liga o freio de mão |
| `semaforoEnv.guard.patterns` | migrations comuns | Expressões regulares dos comandos barrados |
| `semaforoEnv.warnOnStartup` | `true` | Aviso ao abrir com opção remota ativa |

## Segurança

- Nenhuma requisição pra internet. A única verificação de rede é se uma **porta em localhost** está respondendo, pra saber se o serviço subiu.
- Nunca exibe nem registra valores de variáveis, só nomes de grupos, opções, chaves e portas.
- O freio de mão só lê a linha de comando digitada no terminal integrado. Nada é gravado.
- **Não versione o `.env` real.** Versione um `.env.example` com os marcadores e valores falsos.

## Limitações conhecidas

- O freio de mão e a adoção de terminais dependem da integração de shell do VS Code (ativa por padrão no PowerShell, bash e zsh), e só enxergam o terminal integrado. Pra entender por que um serviço não foi reconhecido, abra **Output → Semáforo Env** (com o nível de log em *Trace* aparecem todos os comandos que o terminal informou).
- O reinício certeiro considera que o serviço lê o `.env` da pasta onde ele roda (o comportamento padrão do `dotenv` e do NestJS).
- Requer VS Code 1.93 ou mais recente.

## Desenvolvimento

```bash
npm install
npm test          # compila e roda os testes
npm run package   # gera o .vsix
```

F5 abre uma janela de teste já na pasta `sandbox/`.

## Licença

MIT · feito por [Arabella Dev](https://github.com/pedrogamadev)
