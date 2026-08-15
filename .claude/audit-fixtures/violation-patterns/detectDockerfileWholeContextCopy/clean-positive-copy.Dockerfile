FROM python:3.12-slim
WORKDIR /app
COPY src/ ./src/
COPY pyproject.toml poetry.lock ./
COPY entrypoint.sh ./
RUN pip install -e .
CMD ["./entrypoint.sh"]
