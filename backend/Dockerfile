FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --no-create-home app
COPY --chown=app:app . .
RUN mkdir -p /app/staticfiles && chown app:app /app/staticfiles
USER app
# Static assets require no live database or deployment secrets at build time.
RUN DJANGO_SECRET_KEY=build-only-static-collection SENTRY_DISABLED=true \
    python manage.py collectstatic --noinput
ENV CODE_EXECUTION_ENABLED=false
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz/', timeout=3).read()"
# Query strings may contain OAuth codes; never emit request access logs.
CMD ["daphne", "-b", "0.0.0.0", "-p", "8000", "--access-log", "/dev/null", "Shared_IDE.asgi:application"]
