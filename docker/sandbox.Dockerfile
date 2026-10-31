# Base image of RedGiant workspaces: where agents' shell commands run.
# Extend it per project (FROM redgiant/sandbox) to add toolchains.
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl findutils git less procps python3 ripgrep tini \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system init.defaultBranch main \
 && git config --system safe.directory '*'

WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
