FROM node:14.16

WORKDIR /app
ADD package.json package-lock.json /app/

RUN npm ci

ENV LOOP=1
ENV DELAY=300000
ENV WRITEBACK=1

ADD index.js /app/

CMD ["node", "index.js"]
