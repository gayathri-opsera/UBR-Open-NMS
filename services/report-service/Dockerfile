FROM python:3.11-slim
WORKDIR /app
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
COPY pyproject.toml .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir \
      "fastapi>=0.111.0" "uvicorn[standard]>=0.30.0" \
      "motor>=3.4.0" "aiofiles>=23.2.1" "openpyxl>=3.1.2" \
      "python-dotenv>=1.0.1" "httpx>=0.27.0" \
      "apscheduler>=3.10.4" "aiosmtplib>=3.0.1" \
      "prometheus-client>=0.20.0" "prometheus-fastapi-instrumentator>=7.0.0"
COPY src/ src/
RUN chown -R appuser:appgroup /app
USER appuser
ENV PYTHONPATH=/app/src
EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8091/healthz')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8091"]
