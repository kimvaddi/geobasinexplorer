# Build from this directory, not the repository root (its .dockerignore excludes scanner files):
# docker build --platform linux/amd64 -t gbx-scanner:local services/scanner
FROM python:3.13-slim-bookworm@sha256:281d39ff02e3b389401586134ff9e6572954687822a58055ec07a60ded4e0b7f
WORKDIR /app
RUN mkdir -p work database
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/app TMPDIR=/app/work TEMP=/app/work TMP=/app/work TZ=UTC
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends clamav clamav-freshclam ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.lock.txt /app/requirements.lock.txt
RUN pip install --no-cache-dir --require-hashes -r requirements.lock.txt
RUN chown -R 65534:65534 /app/work /app/database
COPY scan.py /app/scan.py
USER 65534:65534
RUN python3 -c "import scan; scan.self_check()"
ENTRYPOINT ["python3", "/app/scan.py"]
