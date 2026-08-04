FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p data
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
