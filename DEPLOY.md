# Publicação: Cloudflare Pages + backend no Fly.io

```
Navegador ──► Cloudflare Pages (web/ estático) ──/api/*──► Pages Function (proxy) ──► Fly.io (Node + SQLite)
```

O Pages serve a interface e a Function em `functions/` repassa `/api/*` e `/healthz` ao backend.
O navegador só conhece o domínio do Pages, então o cookie de login (`SameSite=Strict`) funciona sem CORS.

> O backend usa SQLite em disco: rode **uma única instância** (já configurado em `fly.toml`).

## 1. Backend no Fly.io

```bash
brew install flyctl && fly auth login
fly launch --no-deploy --copy-config --name SEU-APP        # reaproveita o fly.toml
fly volumes create dados --size 1 --region gru              # onde ficam banco, uploads e backups

# segredos (guarde APP_ENC_KEY em local seguro: sem ela os dados cifrados ficam ilegíveis)
export PROXY_SECRET=$(openssl rand -hex 32)      # mantenha neste terminal: será usado no passo 2
fly secrets set APP_ENC_KEY=$(openssl rand -hex 32) PROXY_SECRET=$PROXY_SECRET
fly secrets list
fly deploy
curl https://SEU-APP.fly.dev/healthz
```

Primeiro gestor:

```bash
fly ssh console -C "sh -c 'GESTOR_SENHA=SuaSenha123 node server/criar-gestor.js \"Seu Nome\" voce@exemplo.com'"
```

## 2. Interface no Cloudflare Pages

```bash
npx wrangler login
npx wrangler pages project create colheita-urbana --production-branch main
npx wrangler pages secret put BACKEND_URL   --project-name colheita-urbana   # https://SEU-APP.fly.dev
printf %s "$PROXY_SECRET" | npx wrangler pages secret put PROXY_SECRET --project-name colheita-urbana   # o mesmo valor do Fly
npx wrangler pages deploy web --project-name colheita-urbana
```

Rode o `deploy` a partir da raiz do projeto (a pasta `functions/` precisa estar ao lado).

**Alternativa com Git:** conecte o repositório no painel do Pages com *build command* vazio, *output directory* `web` e *root* `/`;
depois cadastre `BACKEND_URL` e `PROXY_SECRET` em *Settings → Variables and Secrets* (Production).

## 3. Verificação
- `https://SEU-PROJETO.pages.dev/healthz` deve responder `{"status":"ok",…}`.
- Acessar `https://SEU-APP.fly.dev/api/me` direto deve dar **403** (só o proxy fala com a API).
- Entre com o gestor criado e confira o painel.

## Observações
- **Tempo real (SSE)** passa pelo proxy; o navegador reconecta sozinho se a conexão cair.
- **Domínio próprio**: adicione em *Custom domains* do Pages. O cookie passa a valer nele automaticamente.
- **Dados de demonstração**: não rode `npm run seed` em produção (as senhas são públicas).
- **Backups**: o backup diário fica em `/data/backups` no volume do Fly. Considere `fly volumes snapshots` ou copiar para fora.
- **Mapas**: `MAPS_PROVIDER=local` estima por linha reta. O servidor público do OSRM é só para demonstração; para rotas reais em produção hospede um OSRM próprio ou troque o provedor em `server/lib/maps.js`.
- **E-mail**: ainda é simulado (`outbox_email`); a recuperação de senha em produção exige integrar um provedor em `server/lib/notify.js`.

---

# Alternativa gratuita para demonstração: backend no Render

Planos gratuitos não oferecem disco persistente, então o SQLite é **recriado a cada início**.
Com `AUTO_DEMO=1` o servidor carrega os dados fictícios sozinho (~10 s) antes de aceitar conexões.

1. Em render.com, entre com o GitHub → **New → Blueprint** → escolha o repositório `colheita-urbana` → **Apply** (usa o `render.yaml`).
2. Quando subir, copie a URL (`https://colheita-urbana-demo.onrender.com`) e aponte o Pages para ela:
   ```bash
   printf %s "https://colheita-urbana-demo.onrender.com" | npx wrangler pages secret put BACKEND_URL --project-name colheita-urbana-pedro
   npx wrangler pages deploy web --project-name colheita-urbana-pedro --branch main
   ```
   (O segredo `PROXY_SECRET` do Pages é ignorado quando o backend não o define.)

**Comportamento esperado**
- Após 15 min sem acesso a instância dorme; o próximo acesso demora cerca de 1 min e **volta aos dados fictícios iniciais**, encerrando as sessões.
- Cadastros e doações criados durante o uso desaparecem nesse reinício.
- Sem `PROXY_SECRET`, a API também pode ser acessada diretamente pela URL do Render (aceitável numa demonstração com senhas públicas).
- Não use para dados reais.
