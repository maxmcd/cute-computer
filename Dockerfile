# syntax=docker/dockerfile:1

FROM golang:1.24-trixie AS build

# Set destination for COPY
WORKDIR /app

# Download any Go modules
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg --mount=type=cache,target=/root/.cache/go-build \
	go mod download

# Copy container source code
COPY container_src/*.go ./

# Build
RUN --mount=type=cache,target=/go/pkg --mount=type=cache,target=/root/.cache/go-build \
	go build -o /server

FROM debian:trixie
RUN apt-get update && apt-get install -y curl fuse \
	&& rm -rf /var/lib/apt/lists/*
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then ARCH="amd64"; fi && \
    if [ "$ARCH" = "aarch64" ]; then ARCH="arm64"; fi && \
    VERSION=$(curl -s https://api.github.com/repos/tigrisdata/tigrisfs/releases/latest | grep -o '"tag_name": "[^"]*' | cut -d'"' -f4) && \
    curl -L "https://github.com/tigrisdata/tigrisfs/releases/download/${VERSION}/tigrisfs_${VERSION#v}_linux_${ARCH}.tar.gz" -o /tmp/tigrisfs.tar.gz && \
    tar -xzf /tmp/tigrisfs.tar.gz -C /usr/local/bin/ && \
    rm /tmp/tigrisfs.tar.gz && \
    chmod +x /usr/local/bin/tigrisfs


COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /server /server

EXPOSE 8080
COPY container_src/startup.sh /startup.sh
# Run
CMD ["/startup.sh"]
