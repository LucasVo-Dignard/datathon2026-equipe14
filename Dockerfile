# Image of the web app (app/). Built and pushed to ECR by scripts/deploy-app.sh,
# run on the web server by infra/user_data.sh.tftpl.
FROM node:22-alpine

WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY app/ ./app/

# Prototype JSON data (users, sessions, chats) lives on a host volume mounted at /data.
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=3000 DATA_FILE=/data/db.json
EXPOSE 3000
CMD ["node", "app/server.js"]
