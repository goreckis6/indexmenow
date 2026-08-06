FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY run.py ./

# Baza SQLite mieszka na wolumenie, zeby przetrwac przebudowe obrazu.
RUN mkdir -p /app/data && useradd -m -u 1000 indexer && chown -R indexer:indexer /app
USER indexer

ENV HOST=0.0.0.0 \
    PORT=8006 \
    DATABASE_URL=sqlite:////app/data/indexmeplease.db

EXPOSE 8006

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8006/healthz || exit 1

# Jeden worker jest wymagany: scheduler dziala w procesie aplikacji,
# wiec kilka workerow duplikowaloby zadania indeksowania.
CMD ["python", "-m", "uvicorn", "app.main:app", \
     "--host", "0.0.0.0", "--port", "8006", \
     "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
