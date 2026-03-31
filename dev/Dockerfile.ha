FROM ghcr.io/home-assistant/home-assistant:stable
COPY --from=dreame-mocker / /tmp/dreame-mocker
RUN pip install --no-cache-dir /tmp/dreame-mocker && rm -rf /tmp/dreame-mocker
