FROM python:3.11-slim
WORKDIR /app
COPY pyproject.toml .
RUN pip install --no-cache-dir -e ".[dev]" pyyaml aiohttp prometheus-client
COPY src/ src/
COPY profiles/ profiles/
ENV SIMULATOR_PROFILE=profiles/small-10.yaml
CMD ["python", "src/simulator.py"]
