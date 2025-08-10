FROM node:alpine

# Install Python and build dependencies
RUN apk add --no-cache python3 py3-pip make g++

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

CMD ["node", "index.js"]