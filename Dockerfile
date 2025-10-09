FROM node:18-bullseye

# Install Python3 and pip for detector script
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/render-api

# Install Node deps
COPY render-api/package*.json ./
RUN npm ci || npm install

# Install Python deps (CPU-only)
# Upgrade pip toolchain first for better wheel resolution
RUN python3 -m pip install --upgrade pip setuptools wheel
# Install PyTorch CPU wheels from the official CPU index
RUN pip3 install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
    torch==2.3.1 \
    torchvision==0.18.1
# Install Detectron2 wheel compatible with torch 2.3.x and other deps
RUN pip3 install --no-cache-dir \
    "detectron2 @ https://dl.fbaipublicfiles.com/detectron2/wheels/cu-none/torch2.3/index.html" \
    layoutparser \
    opencv-python-headless \
    pillow

# Copy app
COPY render-api/ ./

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]


