FROM public.ecr.aws/bitnami/node:16
RUN apt-get install git
ENV NODE_ENV=production
RUN npm install -g yarn
RUN npm install -g typescript ts-node

WORKDIR /app

COPY package.json ./

RUN yarn
COPY . .

CMD [ "yarn", "start" ]