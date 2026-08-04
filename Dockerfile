# syntax=docker/dockerfile:1

###############################################################################
# Stage 1 - build: install everything and compile TypeScript to dist/
###############################################################################
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build


###############################################################################
# Stage 2 - prod deps only
###############################################################################
FROM node:22-alpine AS prod-deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev


###############################################################################
# Stage 3 - runtime
###############################################################################
FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache tini \
    && addgroup -g 1001 -S nodejs \
    && adduser -S vakeel -u 1001 -G nodejs

ENV NODE_ENV=production

COPY --from=prod-deps --chown=vakeel:nodejs /app/node_modules ./node_modules
COPY --from=build     --chown=vakeel:nodejs /app/dist ./dist
COPY --chown=vakeel:nodejs supabase ./supabase
COPY --chown=vakeel:nodejs package.json ./

USER vakeel

# Railway injects PORT at runtime; this is the local default.
ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]

# Overridden to `node dist/worker.js` on the worker service.
CMD ["node", "dist/main.js"]
