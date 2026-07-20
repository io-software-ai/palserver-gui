# Builds the palserver agent (with the web UI bundled) into a single image.
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
COPY --from=build /app/packages/agent/package.json packages/agent/
COPY --from=build /app/packages/agent/dist packages/agent/dist
COPY --from=build /app/packages/web/dist packages/web/dist
COPY --from=build /app/THIRD_PARTY_LICENSES.md /app/THIRD_PARTY_LICENSES.md
RUN pnpm install --frozen-lockfile --prod --filter @palserver/agent --filter @palserver/shared
EXPOSE 8250
CMD ["node", "packages/agent/dist/index.js"]
