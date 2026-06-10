# syntax=docker/dockerfile:1
# TODO: distroless·non-root·arm64 이미지로 빌드하라.
# 계약: :8080 http(/healthz,/readyz), :9090 /metrics, db.enabled면 'migrate' 서브커맨드.
FROM gcr.io/distroless/static-debian12:nonroot
USER 65532:65532
