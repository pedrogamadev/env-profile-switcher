# Changelog

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
