FROM python:3.11-slim
WORKDIR /app
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
COPY pyproject.toml ./
RUN pip install --no-cache-dir -e ".[dev]" 2>/dev/null || pip install --no-cache-dir aiokafka motor prometheus-client aiohttp python-dotenv
COPY src/ ./src/
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 9094
CMD ["python", "-m", "src.main"]
