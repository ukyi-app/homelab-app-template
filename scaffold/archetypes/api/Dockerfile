# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM gcr.io/distroless/base-debian12:nonroot
WORKDIR /app
COPY --from=build /app/app /app/app
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/app/app"]
