FROM node:22-bookworm-slim

# Debian's Blender package does not depend on NumPy, but Blender's bundled glTF
# importer imports it at runtime. Without it every Tripo GLB fails before the
# six anatomy renders can be created.
RUN apt-get update \
    && apt-get install -y --no-install-recommends blender ca-certificates libegl1 python3-numpy \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server

ENV HOST=0.0.0.0
ENV BLENDER_BIN=/usr/bin/blender
CMD ["npm", "start"]
