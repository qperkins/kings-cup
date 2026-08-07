FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy game engine
COPY game_engine/ ./game_engine/

# CRITICAL: --proxy-headers tells uvicorn to trust X-Forwarded-For headers
# --forwarded-allow-ips=* means "trust from any source" — acceptable here
# ONLY because nginx is the sole traffic source inside compose network.
# In production with a real LB, scope this to LB IP range (e.g., 10.0.0.0/8).
CMD ["uvicorn", "game_engine.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips=*"]
