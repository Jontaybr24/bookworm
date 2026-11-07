FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public/ ./public/
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
