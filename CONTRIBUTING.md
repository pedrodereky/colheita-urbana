# Como contribuir

1. Use Node.js 22.5+ (`nvm use` lê o `.nvmrc`).
2. Crie um branch a partir da `main`: `git checkout -b minha-mudanca`.
3. Rode `npm run seed` e `npm start` para testar em http://localhost:3000.
4. Rode `npm test` antes de abrir o PR — o GitHub Actions também roda.
5. No PR, cite os requisitos da documentação afetados (RF, RN, UC).

O projeto não usa dependências npm: prefira as APIs nativas do Node.
