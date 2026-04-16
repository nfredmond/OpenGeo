#!/usr/bin/env bash
# Install extensions on fresh Postgres containers so the migrate script
# does not have to deal with superuser grants.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  create extension if not exists "uuid-ossp";
  create extension if not exists pgcrypto;
  create extension if not exists postgis;
  create extension if not exists postgis_raster;
  create extension if not exists vector;
EOSQL
