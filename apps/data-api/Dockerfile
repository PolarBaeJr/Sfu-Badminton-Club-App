# The data API image. Build context is the REPO ROOT, as for every other image:
#   docker build -f apps/data-api/Dockerfile --target runner-data-api .
# CI does exactly that; images are built only in CI, never on a host.
#
# One static musl binary on `scratch`: no shell, no libc, no package manager.
# The service makes plain HTTP calls to Kong and carries its own TLS roots
# (webpki-roots) for an https SUPABASE_URL, so the image needs nothing beside
# the binary.

# ---- Stage 1: compile ----
# The tag pins the same toolchain as apps/data-api/rust-toolchain.toml; change
# both together. rust-toolchain.toml is deliberately NOT copied in: inside this
# image it would make rustup fetch a second copy of a toolchain it already has.
FROM rust:1.99.0-alpine AS builder-data-api
# ring compiles a little C; the image has gcc, this is its libc headers.
RUN apk add --no-cache musl-dev
WORKDIR /build

# Dependencies first, against an empty crate, so that a source-only change
# reuses this layer instead of recompiling every dependency.
COPY apps/data-api/Cargo.toml apps/data-api/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && touch src/lib.rs && \
    cargo build --release --locked && \
    rm -rf src

# package.json is read at compile time for the version /health reports.
COPY apps/data-api/package.json ./
COPY apps/data-api/src ./src
# COPY keeps the files' own mtimes, which can be older than the empty crate
# built above; cargo would then call it up to date and ship `fn main() {}`.
# Dropping this crate's fingerprints forces the real build.
RUN rm -rf target/release/.fingerprint/data-api-* && \
    touch src/main.rs src/lib.rs && \
    cargo build --release --locked && \
    cp target/release/data-api /data-api

# ---- Stage 2: runtime ----
FROM scratch AS runner-data-api
COPY --from=builder-data-api /data-api /data-api

# No /etc/passwd here, so a numeric user: the same uid and gid as before.
USER 1001:1001
ENV PORT=8080
EXPOSE 8080
# No curl, wget or shell in the image: the binary probes itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/data-api", "-healthcheck"]
ENTRYPOINT ["/data-api"]
