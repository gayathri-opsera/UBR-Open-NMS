FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir pyyaml aiohttp
COPY src/ src/
COPY scenarios/ scenarios/
ENTRYPOINT ["python", "src/runner.py"]
