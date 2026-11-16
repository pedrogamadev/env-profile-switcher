# Changelog

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
