# One image, two entrypoints: API (npm start, the default) and worker (npm run worker).
FROM node:26.12.1-trixie-slim

# git is needed by the worker to clone repos
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Run as the unprivileged user that ships with the node image
USER node

EXPOSE 3000
CMD ["npm", "start"]
