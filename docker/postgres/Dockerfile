# OpenGeo local Postgres: PostGIS 15 + pgvector.
# postgis/postgis:15-3.4 doesn't bundle pgvector, which our 00-extensions
# migration needs ("create extension vector"). We layer pgvector on from
# the PGDG apt repo that's already configured in the base image.

FROM postgis/postgis:15-3.4

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-15-pgvector \
  && rm -rf /var/lib/apt/lists/*
