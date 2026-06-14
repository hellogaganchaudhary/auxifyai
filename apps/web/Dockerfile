# Auxify Web (Next.js) — built from the monorepo root context.
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_BASE_URL=... -t auxify-web .
FROM node:22-slim

WORKDIR /app
RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile || pnpm install

# NEXT_PUBLIC_* values are baked at build time, so the API origin must be known
# when the image is built (the API is deployed first; its FQDN is passed here).
ARG NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8787
ARG NEXT_PUBLIC_API_KEY=dev-local-key
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_KEY=$NEXT_PUBLIC_API_KEY

RUN pnpm --filter @auxify/web build

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["pnpm", "--filter", "@auxify/web", "exec", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
