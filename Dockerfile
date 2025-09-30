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
RUN pip3 install --no-cache-dir \
    torch==2.3.1+cpu \
    torchvision==0.18.1+cpu \
    -f https://download.pytorch.org/whl/cpu
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


