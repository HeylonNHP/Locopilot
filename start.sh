#!/usr/bin/env bash
# Start the project: pull latest, install deps, run dev server.
set -euo pipefail

git pull
npm ci
npm run dev