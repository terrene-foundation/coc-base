FROM node:22-alpine
COPY . /app
RUN npm ci --omit=dev
