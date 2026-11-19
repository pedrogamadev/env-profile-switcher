# Changelog

## 0.5.0

Organizar o `.env` sem precisar aprender o formato.

- **Editor em tabela:** cada linha é uma opção e cada coluna é uma variável que o sistema lê. Dá para renomear opções, marcar o que é remoto, escolher a ativa, adicionar e tirar variáveis e editar valores, sempre vendo o antes e depois do `.env` antes de gravar. Os valores aparecem sem usuário e senha até você pedir os completos. Se a opção ativa mudar, os serviços que leem aquele `.env` reiniciam como numa troca normal.
- **O painel mostra o que encontrou:** variáveis com uma linha ativa e outras comentadas aparecem em **Encontrei no seu .env**, com um clique para revisar em tabela ou a varinha para transformar todas.
- **O `.env` se explica:** acima das variáveis com alternativas aparece **Transformar em seletor**. Nos seletores prontos aparecem **Trocar** e **Editar em tabela**. Passar o mouse num marcador mostra o que ele faz e a tabela do seletor, os marcadores ficam esmaecidos, `@danger` fica em vermelho e a opção ativa ganha a marca "← ativa".
- Botão **+** no painel e comando **Novo seletor em tabela** para montar um seletor do zero. Ao adicionar uma variável como coluna, os valores dela que já estão no `.env` entram sozinhos na tabela.
- Tela inicial e README reescritos começando pelo conceito (a tabela). Os marcadores viraram detalhe de "por baixo dos panos".

## 0.4.3

- **Corrigido:** depois de parar e subir um serviço na mão algumas vezes, o painel podia mostrar "parado" com o servidor rodando no terminal. Agora, com o painel aberto, o Semáforo confere a porta a cada poucos segundos (e ao voltar o foco pra janela): porta respondendo com um terminal na pasta do serviço vira "rodando" e passa a ser controlada pelo painel; porta fechada sem processo acompanhado vira "parado".
- **Corrigido:** com o serviço parado, ▶ abria um terminal novo mesmo com um terminal livre na pasta dele. Agora ele reaproveita o terminal do serviço ou um terminal seu parado na mesma pasta, inclusive dividido.
- Quando precisa abrir um terminal novo, ele abre **dividido** ao lado do outro serviço do mesmo sistema, em vez de uma aba nova.
- Logo depois de parar um serviço pelo painel, a porta que ainda demora a fechar não faz ele "voltar" como rodando.
- Ajustar as configurações de serviços não perde mais o estado de quem estava subindo.
- Novo canal **Output → Semáforo Env** com o que o painel adotou, reaproveitou e marcou como parado (em *Trace*, todos os comandos que os terminais informaram). O tooltip do serviço mostra qual terminal ele acompanha.

## 0.4.2

- Exemplos da documentação, do painel e dos testes passam a usar nomes genéricos de sistemas (Loja, Estoque, Pagamentos) e um IP privado de exemplo.

## 0.4.1

- **Corrigido:** escolher o comando em "Qual comando inicia o servidor?" podia falhar com `Unable to write to Workspace Settings because semaforoEnv.restart.command is not a registered configuration`. Isso acontecia, por exemplo, logo depois de a extensão se atualizar sozinha sem recarregar a janela. O reinício simples não grava mais nada em `settings.json` nem no `.code-workspace`.
- O comando de inicialização agora fica salvo **por pasta de projeto** (a pasta do `package.json` escolhido) no estado do workspace. `loja-api` e `loja-app` guardam cada um o seu, e trocar o `.env` de uma pasta reinicia só o servidor dela, num terminal próprio (`Semáforo · loja-api`).
- Os valores antigos de `semaforoEnv.restart.*` são copiados uma vez para o novo formato. As chaves continuam no seu `settings.json` (nada é apagado), mas não são mais lidas e aparecem como obsoletas.
- Novo comando **Redefinir comando de inicialização**, que apaga o comando salvo da pasta que você escolher.
- O script `start` aparece como `npm start` (os demais continuam `npm run <script>`). O gerenciador de pacotes vem do lockfile da pasta ou, se ela não tiver um, da pasta acima (monorepo).
- Toda gravação em configurações mostra um aviso em português quando falha, em vez de um erro solto.

## 0.4.0

O Semáforo virou um hub do ambiente local.

- **Painel Serviços:** cada front e back com ▶ ■ ⟳, logs e status (rodando, iniciando, parado, caiu). Iniciar por sistema (back antes do front) ou tudo de uma vez.
- **Detectar serviços:** lê os `package.json`, identifica front e back e sugere o comando e a porta.
- **Reinício certeiro:** ao trocar um `.env`, só os serviços que rodam na pasta dele reiniciam.
- **Dependências entre sistemas:** aviso quando uma opção ativa aponta pra `localhost:PORTA` e o serviço daquela porta está parado.
- **Vários sistemas na mesma janela:** workspace com várias pastas, um `.env` por sistema e status bar resumindo todos. Comando **Criar workspace do ecossistema**.
- **Organizar .env automaticamente**, com diff do antes e depois.
- **Criar grupo com as linhas selecionadas**, pelo botão direito no editor.
- O painel adota um serviço que você iniciou na mão num terminal.
- Aviso de porta ocupada antes de iniciar.

## 0.3.0

- **Reinício automático do servidor** depois de cada troca: reinicia o terminal onde o servidor já está rodando (Ctrl+C e roda de novo), ou abre um terminal visível próprio. Também funciona com tasks e com a sessão de debug.
- Assistente **Configurar reinício automático**, que lê os scripts do `package.json` (inclusive em subpastas).
- **Freio de mão:** cancela `prisma migrate`, `prisma db push` e equivalentes no terminal quando há opção `@danger` ativa.
- **Aviso ao abrir o projeto** com opção remota ativa.
- Comando **Voltar tudo pra local**.
- Requer VS Code 1.93 ou mais recente.

## 0.2.1

- Ícone novo.

## 0.2.0

- Novo nome: **Semáforo Env**.
- Status bar como semáforo: verde (tudo local), amarelo (grupo inconsistente) e vermelho (opção `@danger` ativa).
- Detecção automática do `.env` em subpasta quando existe um único arquivo (monorepo).
- Novo comando **Escolher arquivo .env**, que salva a escolha nas configurações do workspace.
- Ícones novos.
- Configurações renomeadas de `envProfiles.*` para `semaforoEnv.*`.

## 0.1.0

- Primeira versão: grupos independentes no `.env` com `# @group`, `# @option`, `@danger` e `# @end`.
- View lateral, status bar e troca rápida pelo menu.
- Confirmação antes de ativar opções `@danger`.
- Validação da sintaxe com indicação da linha do erro.
