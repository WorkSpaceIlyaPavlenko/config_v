ARG CADDY_BASE_IMAGE=caddy:2.11.4-alpine
FROM ${CADDY_BASE_IMAGE}

# High container ports need no bind capability. Drop the upstream file
# capability too, so cap_drop=ALL cannot prevent execve of the binary.
RUN setcap -r /usr/bin/caddy \
    && chown -R 65532:65532 /data /config \
    && chmod 0700 /data /config /data/caddy /config/caddy

USER 65532:65532
CMD ["caddy", "run", "--config", "/etc/config-v/Caddyfile", "--adapter", "caddyfile"]
