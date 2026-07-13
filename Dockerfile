FROM rust:1.83-bookworm AS builder
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p openlive-gateway

FROM debian:bookworm-slim
RUN useradd --create-home --uid 10001 openlive
WORKDIR /app
COPY --from=builder /src/target/release/openlive-gateway /usr/local/bin/openlive-gateway
COPY --from=builder /src/apps/openlive-gateway/web /app/web
USER openlive
EXPOSE 8787
ENTRYPOINT ["openlive-gateway"]
CMD ["--listen", "0.0.0.0:8787", "--web-dir", "/app/web"]
