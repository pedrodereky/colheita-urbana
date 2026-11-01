# Colheita Urbana

Plataforma web responsiva que intermedeia a doação de alimentos excedentes entre estabelecimentos (supermercados, padarias, restaurantes) e OSCs, com voluntários transportadores e gestores. Implementa a documentação *Colheita Urbana – Negócios, Requisitos e Modelagem UML* (40 RF, 20 RNF, 34 RN, 46 casos de uso).

## Como rodar

Requer **Node.js 22.5+** (usa o SQLite nativo do Node; **nenhuma dependência npm**).

```bash
npm run seed     # dados de demonstração (opcional)
npm start        # http://localhost:3000
npm test         # 24 testes automatizados (RNF09)
```

Contas de demonstração (senha `Senha@123`):

| Perfil | E-mail |
|---|---|
| Gestor | gestor@colheita.local |
| Estabelecimento | mercado@colheita.local · padaria@colheita.local · restaurante@colheita.local |
| OSC | osc1@colheita.local · osc2@colheita.local · osc3@colheita.local |
| Voluntário | voluntario1@colheita.local (carro) · voluntario2@colheita.local (van) |

Há também um cadastro pendente (`hortifruti@colheita.local`) para testar a análise do gestor.
Em desenvolvimento, e-mails (ex.: recuperação de senha) ficam na tabela `outbox_email` e em `GET /api/dev/emails`.

### Roteiro rápido de demonstração
1. Entre como **OSC** → reserve uma oferta (assistente de 4 passos) → abre a tela da entrega.
2. Em outra janela anônima, entre como **voluntário** → *Aceitar coleta* → *Compartilhar localização* (ou *Simular deslocamento*) → *Registrar coleta*.
3. A OSC acompanha mapa, ETA e chat **ao vivo**, confirma o recebimento (gera o recibo em PDF) e avalia.
4. O **gestor** vê indicadores, ranking, auditoria e exporta CSV/PDF.

## Publicação
Veja [DEPLOY.md](DEPLOY.md): interface no Cloudflare Pages (com Function de proxy para `/api`) e backend Node + SQLite no Fly.io.

## Arquitetura (diagrama de componentes)

Monólito modular, como no diagrama de componentes. Cada módulo da camada de aplicação é um arquivo em `server/modules`:

| Módulo do diagrama | Arquivo | RFs |
|---|---|---|
| API Gateway e Autenticação | `lib/http.js`, `modules/auth.js` | RF26, RF27, RN22 |
| Acesso e Cadastro | `modules/auth.js` | RF01–RF04 |
| Ofertas | `modules/ofertas.js` | RF05–RF07, RF28–RF30 |
| Reservas e Matching | `modules/reservas.js`, `domain/regras.js` | RF08–RF12, RF31 |
| Logística, Rastreamento e Chat | `modules/logistica.js` | RF13–RF15, RF32, RF33, RF37, RF38 |
| Avaliação, Ranking e Reconhecimento | `modules/avaliacao.js` | RF16, RF17, RF20, RF21 |
| Histórico e Recibos | `modules/historico.js` | RF22–RF25, RF39 |
| Gestão e Indicadores | `modules/gestao.js` | RF19, RF35, RNF11 |
| Suporte e Feedback | `modules/suporte.js` | RF34, RF40 |
| Auditoria | `lib/audit.js` | RF18, RNF07 |
| Notificações | `lib/notify.js`, `lib/events.js` | RF11, RF36 |
| Serviço de Mapas (externo) | `lib/maps.js` | RNF10 |
| Rotinas agendadas | `modules/jobs.js` | RF10, RF36, RN03, RN20, RN28, RNF14 |

Máquina de estados da oferta em `server/domain/estados.js` (diagrama em `docs/diagrama-estados.drawio` e `.md`; regenere com `node scripts/gerar-diagrama-estados.mjs`)
(`DISPONIVEL → RESERVADA → EM_COLETA → EM_TRANSPORTE → ENTREGUE → AVALIADA`, além de `RECUSADA`, `EXPIRADA`, `CANCELADA`); toda transição é validada e gravada na auditoria.

Frontend: SPA em JavaScript puro (módulos ES, sem build) em `web/`, mapas com Leaflet empacotado em `web/vendor`.

## Decisões e interpretações

- **Tempo real**: SSE (`/api/stream`) no lugar de WebSocket. O fluxo é só servidor→cliente (posição, estado, chat); o cliente envia por POST.
- **Push / e-mail**: notificações in-app em tempo real + registro em `outbox_email`. Para push/e-mail reais, troque `entregarEmail` em `lib/notify.js`.
- **Mapas**: `MAPS_PROVIDER=local` estima por linha reta (×1,3, 30 km/h); `osrm` usa rotas reais. Se o provedor falhar, aplica os fluxos alternativos UC14 2a e UC20 2a.
- **RF08 (ordenação)**: score = 40% distância + 35% tempo até vencer + 25% fator de histórico (OSCs que receberam menos kg nos últimos 30 dias sobem). Perecíveis de validade curta ganham bônus (RN09).
- **RN14 (capacidade)**: soma das reservas **ativas** (ainda não entregues) por tipo de armazenamento (seca / refrigerada+congelado).
- **RN18 (veículo)**: limites assumidos — bicicleta 15 kg, moto 30 kg, carro 200 kg, van 800 kg, caminhão 5 t (`config.js`).
- **RN12**: três recusas por má qualidade em 30 dias geram um **alerta ao gestor**, que decide se suspende o estabelecimento (nada é bloqueado automaticamente).
- **Cancelamento pela OSC** (além da documentação): antes da coleta a OSC pode cancelar a reserva; a oferta volta à fila, ela não pode reservá-la de novo (RN19) e ninguém recebe falta.
- **Arquivos enviados**: fotos de oferta são visíveis a qualquer usuário logado; comprovantes só à própria OSC e ao gestor; evidências às partes da entrega e ao gestor; anexos de feedback anônimo só ao gestor.
- **UC18 × RN29**: ao vencer a janela, a oferta volta à fila com **janela renovada** (mesma duração, limitada pela validade); a mesma OSC não pode reservar de novo (RN19). Falta é registrada só se um voluntário havia aceitado. O voluntário também pode *desistir* antes de coletar, liberando a coleta a outros (RN29).
- **RN25**: no transporte próprio a OSC registra coleta, problema e entrega; não passa por RN02/RN10/RN20.
- **Ranking (RN21)**: 40% média das notas + 30% volume (até 50) + 30% pontualidade; −20 pontos com 3+ notas 1–2 em 30 dias (RN04).
- **Anonimato (RN31)**: `feedbacks_anonimos` não tem `usuario_id`, grava apenas a **data**; nenhum log registra o autor.
- **LGPD / RNF01**: e-mail, telefone, endereço, CNPJ e CPF cifrados com AES-256-GCM; busca por índice HMAC. Posição do transportador apagada ao fim da entrega (RN32); chat apagado após 7 dias.
- **RNF20**: a trilha de auditoria expõe autores pseudonimizados e possui cadeia de hash (`/api/gestor/auditoria?verificar=1`) com triggers que impedem UPDATE/DELETE.
- **RNF05, 12, 13, 16, 17** são de infraestrutura: o `Dockerfile` traz healthcheck e o `docker-compose.yml` reinício automático; backup diário (RNF14) roda no agendador (`data/backups`, 14 dias). Escalonamento horizontal exige trocar SQLite por um banco de rede (o acesso está isolado em `server/db.js`).

## Variáveis de ambiente
Veja `.env.example`. Em produção defina `APP_ENC_KEY` (64 hex) — **perder a chave torna os dados sensíveis ilegíveis**.
