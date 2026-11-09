# GeoBasin Explorer AI spatial service: GDAL/OGR/OSR (PROJ) on the official GDAL image, with the same GA data the
# app bundles. Internal only; see services/spatial/server.py.
# The build context is the repository root:
#   az acr build -r <registry> -t gbx-spatial:<tag> -f services/spatial/Dockerfile .
FROM ghcr.io/osgeo/gdal:ubuntu-small-3.13.3
# Fail the build early if the Python bindings are missing.
RUN python3 -c "from osgeo import gdal, ogr, osr; print('GDAL', gdal.__version__)"
WORKDIR /app
COPY app/src/data/basins-pack.json app/src/data/app-pack.json /app/data/
COPY services/spatial/server.py /app/server.py
# Load the data once at build time too, so a broken pack fails the build rather than the deployment, and rerun the
# locked reference fixture: a 260 km west-east Cooper Basin section with 464 boreholes within 10 km.
RUN GBX_DATA_DIR=/app/data timeout 120 python3 -c "import runpy, sys; sys.argv=['x']; m = runpy.run_path('/app/server.py', run_name='check'); r = m['section']((139.55, -28.05), (142.2, -27.95))['reference']; assert (round(r['lengthKm'], 2), r['boreholes']) == (260.41, 464), r; print('ok', len(m['BASINS']), 'basins; fixture', round(r['lengthKm'], 2), 'km,', r['boreholes'], 'boreholes')"
USER 65534:65534
ENV PORT=8080 GBX_DATA_DIR=/app/data PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python3", "/app/server.py"]
