FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    CIPHER_HOST=0.0.0.0 \
    CIPHER_PORT=10000 \
    CIPHER_BLOB_DIR=/data/blobs

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN mkdir -p /data/blobs

EXPOSE 10000
CMD ["python", "server.py"]
