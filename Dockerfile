# Flambo Stock: un solo contenedor con la API y el frontend.
# No hay dependencias que instalar (el backend usa solo Node.js), así que la imagen es chica y reproducible.
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/flambo.db \
    STATIC_DIR=/app/frontend \
    TRUST_PROXY=true

WORKDIR /app/backend

COPY backend/package.json ./
COPY backend/src ./src
COPY backend/scripts ./scripts
COPY frontend /app/frontend

# La base vive en /data (un volumen); el proceso corre sin privilegios de administrador.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
