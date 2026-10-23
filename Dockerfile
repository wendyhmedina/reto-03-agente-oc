# Imagen de despliegue: front + backend en un solo proceso Bun.
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY agent ./agent
COPY src ./src
COPY web ./web
COPY fixtures ./fixtures
COPY tsconfig.json ./
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# out/ se crea en tiempo de ejecución (SAP simulado, evidencias, logs). En plataformas sin disco persistente se reinicia con cada despliegue.
CMD ["bun", "run", "src/server.ts"]
