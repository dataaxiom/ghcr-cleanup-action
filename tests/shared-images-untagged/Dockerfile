FROM node:22.6.0-alpine3.20 AS base-image
WORKDIR /app

FROM base-image
ENV NODE_ENV=production
ENV PORT=3000
USER node
HEALTHCHECK CMD curl --fail http://localhost:3000 || exit 1",
EXPOSE 3000
