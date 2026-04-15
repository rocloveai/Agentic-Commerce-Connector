FROM node:20-slim AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/connector/package.json ./packages/connector/
COPY packages/skill-spec/package.json ./packages/skill-spec/
COPY packages/cli/package.json ./packages/cli/
RUN npm ci

COPY packages/skill-spec ./packages/skill-spec
COPY packages/connector/tsconfig.json ./packages/connector/
COPY packages/connector/src ./packages/connector/src
RUN npm run build --workspace packages/skill-spec \
 && npm run build --workspace packages/connector

FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/connector/package.json ./packages/connector/
COPY packages/skill-spec/package.json ./packages/skill-spec/
RUN npm ci --omit=dev --workspace packages/connector --include-workspace-root

COPY --from=builder /app/packages/skill-spec/build ./packages/skill-spec/build
COPY --from=builder /app/packages/skill-spec/schemas ./packages/skill-spec/schemas
COPY --from=builder /app/packages/connector/build ./packages/connector/build
COPY packages/connector/skill.md ./packages/connector/

ENV TRANSPORT=http
ENV PORTAL_HOST=0.0.0.0
ENV PORTAL_PORT=10000
EXPOSE 10000
WORKDIR /app/packages/connector
CMD ["node", "build/server.js"]
