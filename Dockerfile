# Stage 1 installs the dependencies with npm. Node and npm stay behind in this stage.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Electron fetches its browser binary on first run, so fetch it here. Then drop the parts a
# server never uses: the third-party licence page, every UI language but English, and the
# SwiftShader Vulkan libraries (the container runs with --disable-gpu and draws on the CPU).
RUN npm ci --omit=dev \
 && node node_modules/electron/install.js \
 && cd node_modules/electron/dist \
 && rm -f LICENSES.chromium.html libvk_swiftshader.so libvulkan.so.1 vk_swiftshader_icd.json \
 && find locales -type f ! -name 'en-US.pak' -delete

# Stage 2 is what ships. It has no Node: Electron carries its own and runs the app directly.
FROM debian:bookworm-slim
# What Electron's Chromium links against, plus a virtual display for its windows.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation xvfb xauth \
      libgtk-3-0 libnss3 libasound2 libgbm1 libdrm2 libxkbcommon0 libxss1 libxtst6 \
      libatk1.0-0 libatk-bridge2.0-0 libcups2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libpango-1.0-0 libcairo2 \
 # GTK pulls in an icon theme and docs that a windowless server never shows.
 && rm -rf /var/lib/apt/lists/* /usr/share/icons /usr/share/doc /usr/share/man /usr/share/locale \
 # Mesa's software 3D drivers (LLVM alone is 107 MB) come along with GTK. With --disable-gpu
 # nothing loads them: pages are drawn on the CPU by Chromium itself.
 && rm -rf /usr/lib/*-linux-gnu/libLLVM-*.so* /usr/lib/*-linux-gnu/libz3.so* /usr/lib/*-linux-gnu/dri \
 && useradd --uid 1000 --create-home pagepeek

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json env.mjs server.mjs ask.mjs index.html ./

# Listen on every interface inside the container. compose.yaml decides what the host exposes.
ENV PAGEPEEK_BIND=0.0.0.0
USER pagepeek
EXPOSE 8787
# --no-sandbox: Chromium's own sandbox needs kernel features Docker withholds from a
# container, so the container is the isolation here.
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x1024x24", \
     "node_modules/electron/dist/electron", "--no-sandbox", "--disable-gpu", "."]
