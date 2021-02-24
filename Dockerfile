FROM node:14.16

WORKDIR /app
ADD package.json package-lock.json /app/

RUN npm ci

ENV LOOP=1
ENV DELAY=60000

CMD ["node", "index.js"]
