FROM node:24-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
# モデル名は固定（古い SDK による暗黙リマップ回避）。デプロイ時に上書き可。
ENV GEMINI_MODEL=gemini-3-flash-preview

EXPOSE 8080
CMD ["node", "server.js"]
