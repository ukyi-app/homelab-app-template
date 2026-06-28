# syntax=docker/dockerfile:1
# TODO: distroless·non-root·arm64 이미지로 빌드하라.
# service 계약: :8080 http(/health). metrics.enabled=true일 때만 :9090 /metrics.
FROM gcr.io/distroless/static-debian12:nonroot
USER 65532:65532
