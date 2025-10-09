FROM node:18-bullseye

# Install Python3 and pip for detector script
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-dev \
    git \
    build-essential \
    cmake \
    ninja-build \
    pkg-config \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/render-api

# Install Node deps
COPY render-api/package*.json ./
RUN npm ci || npm install

# Install Python deps (CPU-only)
# Upgrade pip toolchain first for better wheel resolution
RUN python3 -m pip install --upgrade pip setuptools wheel
# Install PyTorch CPU wheels from the official CPU index
RUN pip3 install --no-cache-dir 'numpy<2' \
 && pip3 install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
    torch==2.2.2 \
    torchvision==0.17.2
# Install Detectron2 wheel compatible with torch 2.2.x and other deps
RUN pip3 install --no-cache-dir \
    "git+https://github.com/facebookresearch/detectron2.git" \
    "layoutparser[layoutmodels]" \
    "opencv-python-headless<4.10" \
    pillow \
    transformers \
    pillow \
    torchmetrics

# Copy app
COPY render-api/ ./

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]


