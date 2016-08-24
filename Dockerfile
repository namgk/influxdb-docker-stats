FROM node:6.1.0

RUN mkdir /app
WORKDIR /app

ADD package.json /app/
RUN npm install --production

ADD . /app

CMD ["npm","start"]
