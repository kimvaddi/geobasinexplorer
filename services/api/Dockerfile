# Default web target contains the web/API, legacy ingestion and evaluation code, without Poppler.
# The separate pipeline target adds the pinned native parser only for gbx-connect and gbx-process.
# The build context is the repository root:
#   az acr build -r <registry> -t gbx-api:<tag> -f services/api/Dockerfile .
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY app/package.json app/package-lock.json app/
RUN cd app && npm ci --no-audit --no-fund
COPY services/api/package.json services/api/package-lock.json services/api/
RUN cd services/api && npm ci --no-audit --no-fund
COPY app app
COPY services/api services/api
# The cloud builds of the app and the API strip withheld sources with the shared licence tooling.
COPY tools/cloud-build.mjs tools/cloud-build.mjs
# Brand pack for the UI (app/src/brand/<name>). GeoBasin is the default; an organisation adds its own pack (a logo and a
# theme.css) and builds with it, so the tag names the pack:
#   az acr build ... --build-arg GBX_BRAND=<pack> -t gbx-api:<version>-<stamp>-<pack> (infra/scripts/deploy.sh build)
ARG GBX_BRAND=geobasin
RUN cd app && VITE_BRAND="$GBX_BRAND" npm run build:cloud
RUN cd services/api && npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production PORT=8080 GBX_QUESTIONS_FILE=/app/eval/questions.json
WORKDIR /app
COPY --from=build /src/services/api/package.json ./
COPY --from=build /src/services/api/node_modules ./node_modules
COPY --from=build /src/services/api/dist ./dist
COPY --from=build /src/app/dist-cloud ./public
COPY tests/answers/questions.json ./eval/questions.json
USER node
EXPOSE 8080
CMD ["node", "dist/server.mjs"]


# Build with --target pipeline and tag gbx-pipeline, never the internet-facing gbx-api image.
FROM api AS pipeline
USER root
# Verified for amd64 and arm64 in the official Debian bookworm-security package indexes.
ARG POPPLER_UTILS_VERSION=22.12.0-2+deb12u3
ENV GBX_POPPLER_PACKAGE_VERSION=${POPPLER_UTILS_VERSION}
RUN apt-get update && apt-get install -y --no-install-recommends "poppler-utils=${POPPLER_UTILS_VERSION}"     && test "$(dpkg-query -W -f='${Version}' poppler-utils)" = "${POPPLER_UTILS_VERSION}"     && rm -rf /var/lib/apt/lists/* && mkdir .gbx-runs && chown node:node .gbx-runs
USER node
CMD ["node", "dist/scripts/live-process.mjs"]

# Last stage is the default target used by CI and the web/evaluation deployment. It does not inherit pipeline.
FROM api AS web
