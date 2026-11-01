# Colheita Urbana - imagem do backend (sem dependências npm)
FROM node:24-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web
COPY docker-entrypoint.sh /usr/local/bin/
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
# RNF13: a plataforma reinicia o contêiner se o healthcheck falhar
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
