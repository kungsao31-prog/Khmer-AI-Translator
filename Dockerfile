FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV FFMPEG_PATH=/usr/bin/ffmpeg

# Debian Bookworm does not provide fonts-khmeros-core in this image.
# Use the Noto font packages and verify Khmer glyph coverage at build time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       fontconfig \
       fonts-noto-core \
       fonts-noto-extra \
       libass9 \
       libharfbuzz0b \
       libfribidi0 \
    && fc-cache -f \
    && fc-match "Noto Sans Khmer" \
    && fc-list :lang=km | grep -qi "Noto Sans Khmer" \
    && ffmpeg -hide_banner -filters 2>&1 | grep -q subtitles \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
EXPOSE 3000
CMD ["npm", "start"]
