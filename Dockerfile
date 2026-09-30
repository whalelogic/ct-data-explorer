# syntax=docker/dockerfile:1

# ---- install deps ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Copy deps from first step, then the app source (see .dockerignore)
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

# Run as the unprivileged "node" user that ships with the image
USER node

EXPOSE 3000
CMD ["node", "src/server.js"]
