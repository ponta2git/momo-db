ARG POSTGRES_IMAGE=postgres:18
FROM ${POSTGRES_IMAGE}
RUN apt-get update \
    && apt-get install -y --no-install-recommends netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*
