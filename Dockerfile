FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends blender ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server

ENV HOST=0.0.0.0
ENV BLENDER_BIN=/usr/bin/blender
CMD ["npm", "start"]
