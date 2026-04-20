FROM debian:bookworm-slim AS tippecanoe-builder

ARG TIPPECANOE_REPO=https://github.com/felt/tippecanoe.git
ARG TIPPECANOE_REF=cb6cacef152e649d4500af1f4fa9b4c8f1f98d64

WORKDIR /src

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     build-essential \
     ca-certificates \
     git \
     libsqlite3-dev \
     zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

RUN git init tippecanoe \
  && cd tippecanoe \
  && git remote add origin "$TIPPECANOE_REPO" \
  && git fetch --depth 1 origin "$TIPPECANOE_REF" \
  && git checkout FETCH_HEAD \
  && make -j"$(nproc)" \
  && make install PREFIX=/usr/local

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8110 \
    TIPPECANOE_BIN=tippecanoe

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 zlib1g \
  && rm -rf /var/lib/apt/lists/*

COPY --from=tippecanoe-builder /usr/local/bin/tippecanoe /usr/local/bin/tippecanoe
COPY --from=tippecanoe-builder /usr/local/bin/tile-join /usr/local/bin/tile-join

COPY server.mjs ./

EXPOSE 8110

CMD ["node", "server.mjs"]
