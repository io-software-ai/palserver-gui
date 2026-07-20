# Builds the palserver-GUI official Discord bot into a single image.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
ENV CI=true
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r build

FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/discord-bot/package.json packages/discord-bot/
COPY --from=build /app/packages/discord-bot/dist packages/discord-bot/dist
RUN pnpm install --frozen-lockfile --prod --filter @palserver/discord-bot --filter @palserver/shared
CMD ["node", "packages/discord-bot/dist/index.js"]
