FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng gosu \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node dist ./dist
COPY --chown=node:node server ./server
COPY --chmod=755 deploy/entrypoint.sh /usr/local/bin/briefcase-entrypoint
ENV NODE_ENV=production BRIEFCASE_HOST=0.0.0.0 BRIEFCASE_DB=/data/briefcase.sqlite
ENTRYPOINT ["briefcase-entrypoint"]
CMD ["node", "server/start.mjs"]
