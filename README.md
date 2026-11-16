# Semáforo Env

**O hub do seu ambiente local.** Troque bancos e APIs do `.env` com um clique, suba e reinicie o front e o back de vários sistemas num painel só, e pare de rodar migration no lugar errado.

**[Instalar pelo VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=arabella-dev.semaforo-env)** · ou no VS Code: Ctrl+Shift+X → pesquise `Semáforo Env`

![Demonstração](media/demo.gif)

## O que ele resolve

| Antes | Com o Semáforo |
|---|---|
| Comentar e descomentar linhas do `.env` pra trocar de banco | Um clique na opção desejada |
| Ctrl+C no terminal e subir o servidor de novo depois de cada troca | Os serviços que leem aquele `.env` reiniciam sozinhos |
| Abrir 6 terminais pra testar 3 sistemas que conversam entre si | Painel **Serviços** com ▶ ■ ⟳ por serviço, por sistema ou tudo de uma vez |
| Descobrir no log que a API local do outro sistema estava desligada | Aviso: "API do Controle está em local, mas controle · back está parado", com o botão **Iniciar** |
| Esquecer o homolog ligado | Status bar vermelha, aviso ao abrir o projeto e **🏠 Voltar tudo pra local** |
| Rodar `prisma migrate dev` apontando pro banco da equipe | **Freio de mão:** o comando é cancelado e o Semáforo pergunta antes |

## Começando em 2 minutos

1. **Organize o `.env`:** na barra lateral do Semáforo, clique em **Organizar .env automaticamente**. Ele encontra as variáveis com alternativas (a ativa e as comentadas), monta os grupos e mostra o antes e depois. Nenhum valor muda.
2. **Detecte os serviços:** no painel **Serviços**, clique em **Detectar serviços**. O Semáforo lê os `package.json`, identifica o que é front e o que é back e sugere o comando e a porta de cada um.
3. **Use:** clique nas opções pra trocar de ambiente e nos botões pra subir os serviços. O resto é automático.

## Perfis do `.env`

O Semáforo organiza o seu `.env` em **grupos independentes**. Exemplo: banco em `teste` e API do outro sistema em `homolog` ao mesmo tempo. Tudo fica no próprio `.env`, então Prisma, `dotenv`, `tsx` e Docker continuam lendo o arquivo normal.

```env
# @group Banco
# @option local
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app
DIRECT_URL=postgresql://postgres:postgres@localhost:5432/app
# @option supabase @danger
# DATABASE_URL=postgresql://usuario:senha@db.supabase.co:6543/postgres
# DIRECT_URL=postgresql://usuario:senha@db.supabase.co:5432/postgres
# @end

# @group API do Controle
# @option local
CONTROLE_API_URL=http://localhost:3034/api
# @option homolog @danger
# CONTROLE_API_URL=https://homolog.exemplo/api
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

### Organizar sem escrever marcador nenhum

- **Organizar .env automaticamente:** o Semáforo nomeia as opções pelo endereço (`localhost` vira **local**, `*.supabase.com` vira **supabase**, um host com "homolog" vira **homolog**...) ou por um comentário curto logo acima da linha (`#Homolog`). Tudo que não aponta pra máquina local é marcado como `@danger`, e variáveis que mudam juntas (ex.: `DATABASE_URL` e `DIRECT_URL` no mesmo host) entram na mesma opção.
- **Criar grupo com as linhas selecionadas:** selecione as linhas no editor → botão direito → **Semáforo: Criar grupo com as linhas selecionadas**.

Nos dois casos, você vê um diff com o antes e depois e só aplica se aprovar.

## Serviços

O painel **Serviços** mostra cada front e back com um semáforo próprio:

| Bolinha | Estado |
|---|---|
| 🟢 | Rodando (a porta respondeu) |
| 🟡 | Iniciando |
| ⚪ | Parado |
| 🔴 | Caiu (o processo terminou com erro) |

- **▶ ■ ⟳** por serviço, **▶** por sistema (sobe o back antes do front) e **Iniciar/Parar todos** no topo.
- Cada serviço roda no **próprio terminal visível** (`sgc · back`, `sgc · front`...). Clique no serviço pra ver os logs.
- **Reinício certeiro:** ao trocar um `.env`, só reiniciam os serviços que rodam na pasta daquele `.env`. O front não reinicia quando você troca o banco do back.
- **Dependências:** se uma opção ativa aponta pra `localhost:PORTA` e o serviço daquela porta está parado, o painel avisa e oferece **Iniciar**.
- **Adota o que você já roda:** se você mesmo rodar `npm run dev` num terminal, na pasta de um serviço configurado, o painel reconhece e passa a controlar aquele terminal.
- **Porta ocupada:** antes de iniciar, o Semáforo avisa se a porta já está em uso por outro processo.

## Vários sistemas juntos (ecossistema)

Pra testar sistemas que conversam entre si (ex.: Controle, SGC e Oráculo, cada um com front e back), abra todos numa janela só com um **workspace de várias pastas**:

1. No painel **Serviços** (menu **⋯**), use **Criar workspace do ecossistema** e escolha as pastas dos sistemas.
2. Abra o workspace criado.
3. Clique em **Detectar serviços**.

Cada sistema passa a ter o **seu** `.env` no painel **Perfis**, e a status bar resume todos (ex.: `sgc: homolog · controle · oraculo`). Os serviços ficam salvos no próprio arquivo `.code-workspace`, então dá pra versionar e a equipe inteira ganha o mesmo painel:

```json
{
  "folders": [{ "path": "controle" }, { "path": "sgc" }, { "path": "oraculo" }],
  "settings": {
    "semaforoEnv.services": [
      { "system": "sgc", "name": "back", "folder": "sgc", "cwd": "sgc-api", "command": "npm run start:dev", "port": 3000 },
      { "system": "sgc", "name": "front", "folder": "sgc", "cwd": "sgc-web", "command": "npm run dev", "port": 5174 }
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

## Configurações

| Setting | Padrão | Descrição |
|---|---|---|
| `semaforoEnv.file` | `.env` | `.env` controlado, relativo à pasta. Em workspaces de várias pastas, cada sistema tem o seu |
| `semaforoEnv.services` | `[]` | Serviços do painel: `system`, `name`, `folder`, `cwd`, `command`, `port` |
| `semaforoEnv.restart.mode` | `off` | Reinício simples: `terminal`, `task`, `debug` ou `off` |
| `semaforoEnv.restart.command` | | Comando do servidor no reinício simples |
| `semaforoEnv.restart.cwd` | | Pasta usada quando é preciso abrir um terminal novo |
| `semaforoEnv.restart.task` | | Task usada no modo `task` |
| `semaforoEnv.showRestartHint` | `true` | Lembrete pra reiniciar quando nada está configurado |
| `semaforoEnv.guard.enabled` | `true` | Liga o freio de mão |
| `semaforoEnv.guard.patterns` | migrations comuns | Expressões regulares dos comandos barrados |
| `semaforoEnv.warnOnStartup` | `true` | Aviso ao abrir com opção remota ativa |

## Segurança

- Nenhuma requisição pra internet. A única verificação de rede é se uma **porta em localhost** está respondendo, pra saber se o serviço subiu.
- Nunca exibe nem registra valores de variáveis, só nomes de grupos, opções, chaves e portas.
- O freio de mão só lê a linha de comando digitada no terminal integrado. Nada é gravado.
- **Não versione o `.env` real.** Versione um `.env.example` com os marcadores e valores falsos.

## Limitações conhecidas

- O freio de mão e a adoção de terminais dependem da integração de shell do VS Code (ativa por padrão no PowerShell, bash e zsh), e só enxergam o terminal integrado.
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
