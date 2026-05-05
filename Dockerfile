FROM node:alpine
RUN apk add --no-cache python3 py3-pip make g++
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev --silent --no-fund
COPY . .
CMD ["node", "index.js"]