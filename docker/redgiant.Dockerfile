# RedGiant: server, supervisor, egress proxy and web UI in one image.
#   docker build -f docker/redgiant.Dockerfile -t redgiant/redgiant:dev .
# The source and its node_modules stay in the image: God's code changes are rebuilt from them.
# The web page and the browser extension are the same files on every processor: built once, on the
# builder's own one (3.5.3: under arm64 emulation vite went on for hours on the 3.5.x editors).
FROM --platform=$BUILDPLATFORM node:24-trixie-slim AS web
WORKDIR /opt/redgiant
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm exec tsc -b \
 && pnpm --filter @redgiant/web build \
 && pnpm --filter @redgiant/browser-extension build

FROM node:24-trixie-slim AS build
WORKDIR /opt/redgiant
RUN corepack enable
COPY . .
# Each processor's own packages (the embedded Postgres, native modules) and the server's TypeScript.
RUN pnpm install --frozen-lockfile && pnpm exec tsc -b
COPY --from=web /opt/redgiant/packages/web/dist packages/web/dist
COPY --from=web /opt/redgiant/packages/browser-extension/dist packages/browser-extension/dist
# Codex and Claude Code (hundreds of MB) come down only when a subscription is switched on
# (2026-11-05), into the data volume.
RUN rm -rf node_modules/.pnpm/@openai+codex@*-linux-* node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-*

FROM node:24-trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git less procps python3 ripgrep tini util-linux \
    ghostscript libx11-6 libx11-xcb1 libxext6 libxinerama1 libcairo2 libcups2t64 libdbus-1-3 libfontconfig1 \
    libfreetype6 libglib2.0-0t64 libgssapi-krb5-2 libnss3 fonts-dejavu-core \
    xvfb xauth xz-utils libxfixes3 libxi6 libxkbcommon0 \
    libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && git config --system init.defaultBranch live \
 && git config --system safe.directory '*'
# The knowledge (G36.2): llama.cpp's CPU build for local embeddings and reranking comes down into
# the data volume when chosen; it links OpenMP (libgomp1, 0.3 MB).
# Conversions into open formats (G34.3): Ghostscript (AGPL-3.0, Debian's own package, a separate
# program) for EPS and PostScript; the libraries LibreOffice's AppImage needs without a desktop
# (LibreOffice itself, ~300 MB, comes down into the data volume only when a conversion needs it).
# Scribus's AppImage (IDML with its layout) needs a display: Xvfb and xauth (55 MB download,
# ~230 MB installed, Mesa included). Blender's tar.xz needs xz, and Blender three X libraries
# (libxfixes3, libxi6, libxkbcommon0; under 1 MB). Both programs come down only when needed.
# RedGiant 2.0 (2026-11-04): agents run their commands here, no container of their own: the
# tools the sandbox image had (curl, less, procps, ripgrep) are here too.
# uv, for the catalog's MCP servers published on PyPI (uvx), G24.14c.
COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /uvx /usr/local/bin/
COPY --from=build /opt/redgiant /opt/redgiant
COPY docker/entrypoint.sh /usr/local/bin/redgiant-entrypoint
# Declared here, at its only use (G36.18): an ARG before a RUN is in that RUN's environment, so a
# new version made the apt and uv layers new too (3.3.0 → 3.3.1: 373 of 455 MB to download again).
ARG REDGIANT_VERSION=dev
RUN chmod 755 /usr/local/bin/redgiant-entrypoint \
 && echo "${REDGIANT_VERSION}" > /opt/redgiant/.image-version \
 && corepack prepare "$(node -p "require('/opt/redgiant/package.json').packageManager")" --activate \
 && su node -s /bin/sh -c 'corepack prepare "$(node -p "require(\"/opt/redgiant/package.json\").packageManager")" --activate'
ENV REDGIANT_DATA_DIR=/data \
    REDGIANT_PORT=7600 \
    REDGIANT_HOST=0.0.0.0 \
    REDGIANT_WEB_DIR=/opt/redgiant/packages/web/dist
VOLUME ["/data"]
EXPOSE 7600
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.REDGIANT_PORT||7600)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/redgiant-entrypoint"]
