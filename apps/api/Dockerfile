# Auxify API — built from the monorepo root context.
#   docker build -f apps/api/Dockerfile -t auxify-api .
FROM node:22-slim

# pdf/word/image parsers are pure JS; only ca-certificates are needed for TLS.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable

# Install all workspace dependencies against the committed lockfile.
COPY . .
RUN pnpm install --frozen-lockfile || pnpm install

ENV NODE_ENV=production
# Bind all interfaces inside the container (Azure routes to this port).
ENV API_HOST=0.0.0.0
ENV API_PORT=8787
EXPOSE 8787

# Run the API via tsx (no separate build step needed for the TS sources).
CMD ["pnpm", "--filter", "@auxify/api", "start"]
