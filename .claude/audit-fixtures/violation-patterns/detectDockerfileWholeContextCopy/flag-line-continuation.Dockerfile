FROM rust:1.83
WORKDIR /src
COPY \
  . \
  .
RUN cargo build --release
