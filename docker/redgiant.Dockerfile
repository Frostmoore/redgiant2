# RedGiant: server, supervisor, egress proxy and web UI in one image.
#   docker build -f docker/redgiant.Dockerfile -t redgiant/redgiant:dev .
# The source and its node_modules stay in the image: God's code changes are rebuilt from them.
FROM node:24-trixie-slim AS build
WORKDIR /opt/redgiant
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24-trixie-slim
ARG REDGIANT_VERSION=dev
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 tini util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && git config --system init.defaultBranch live \
 && git config --system safe.directory '*'
# uv, for the catalog's MCP servers published on PyPI (uvx), G24.14c.
COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /uvx /usr/local/bin/
COPY --from=build /opt/redgiant /opt/redgiant
COPY docker/entrypoint.sh /usr/local/bin/redgiant-entrypoint
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
