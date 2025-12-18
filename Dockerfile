# syntax=docker/dockerfile:1
FROM golang:1.25-trixie AS builder

RUN apt-get update \
    && apt-get install -y unzip \
    && curl -fsSL https://bun.com/install | bash

WORKDIR /opt
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY ./container_src ./container_src
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    cd ./container_src && go build -o /server .

FROM debian:trixie
RUN apt-get update && apt-get install -y curl unzip media-types ca-certificates fuse \
	&& rm -rf /var/lib/apt/lists/*
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then ARCH="amd64"; fi && \
    if [ "$ARCH" = "aarch64" ]; then ARCH="arm64"; fi && \
    VERSION=$(curl -s https://api.github.com/repos/tigrisdata/tigrisfs/releases/latest | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4) && \
    curl -L "https://github.com/tigrisdata/tigrisfs/releases/download/${VERSION}/tigrisfs_${VERSION#v}_linux_${ARCH}.tar.gz" -o /tmp/tigrisfs.tar.gz && \
    tar -xzf /tmp/tigrisfs.tar.gz -C /usr/local/bin/ && \
    rm /tmp/tigrisfs.tar.gz && \
    chmod +x /usr/local/bin/tigrisfs

# Create cutie user with home directory 
RUN useradd -m -s /bin/bash cutie

COPY --from=builder /server /server
WORKDIR /opt

EXPOSE 8283

USER cutie
# Run server as root, but shell sessions will run as cutie
CMD ["/server"]
