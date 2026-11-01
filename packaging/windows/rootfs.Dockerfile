# The WSL distribution for RedGiant-Setup.exe (G22): Debian with Docker Engine and systemd. Built in
# CI and exported as a tarball (`docker export`), then imported on Windows with `wsl --import`.
FROM debian:trixie-slim
ARG REDGIANT_REF=main
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg jq systemd systemd-sysv dbus iptables procps \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin \
 && apt-get clean && rm -rf /var/lib/apt/lists/* \
 && systemctl enable docker containerd
COPY packaging/windows/rootfs/wsl.conf /etc/wsl.conf
COPY packaging/windows/rootfs/redgiant-wsl /usr/local/bin/redgiant-wsl
COPY install.sh /usr/local/share/redgiant/install.sh
RUN echo "$REDGIANT_REF" > /etc/redgiant-ref && chmod +x /usr/local/bin/redgiant-wsl
