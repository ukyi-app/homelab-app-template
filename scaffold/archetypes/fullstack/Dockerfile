# syntax=docker/dockerfile:1
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM gcr.io/distroless/base-debian12:nonroot
WORKDIR /app
COPY --from=build /app/app /app/app
COPY --from=build /app/web/dist /app/web/dist
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/app/app"]
