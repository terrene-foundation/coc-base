FROM rust:1.83 AS builder
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src/ ./src/
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=builder /src/target/release/app /usr/local/bin/app
COPY --from=builder . .
CMD ["app"]
