FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY apps/api/package*.json ./
RUN npm ci

COPY apps/api/tsconfig*.json ./
COPY apps/api/src ./src

RUN npm run build

FROM node:20-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3030

CMD ["node", "dist/main.js"]
