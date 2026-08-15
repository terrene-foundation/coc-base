FROM python:3.12-slim
WORKDIR /app
COPY src/ . /app/
RUN pip install -e .
