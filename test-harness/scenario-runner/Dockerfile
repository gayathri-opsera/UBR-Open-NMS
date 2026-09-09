FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir pyyaml aiohttp fastapi uvicorn motor
COPY src/ src/
COPY scenarios/ scenarios/
# Default to running the FastAPI server for release acceptance API
CMD ["uvicorn", "src.app:app", "--host", "0.0.0.0", "--port", "3009"]
