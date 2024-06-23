FROM node:20

ENV NODE_ENV production

WORKDIR /opt/vostok

COPY package.json package-lock.json ./

RUN npm ci --only=production

USER node

COPY src/ src/

EXPOSE 1965

ENTRYPOINT ["node", "src/vostok.js"]
