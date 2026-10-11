# VPN deployment templates

`templates/` contains the reviewed protocol configuration. The generator writes private node files under `runtime/<node>/`; Terraform manages the selected Docker runtime separately. Neither these templates nor Terraform select or install a VPS runtime. First determine whether Linux will use rootless containers or a separate VM, after checking resources and virtualization support.

The production templates require the same real domain pointing to the VPS. Use a different UUID per person/device. Keep generated keys, client URIs, and full configs private; do not bake them into images or pass secret contents through Terraform variables, `env`, or `upload.content`. Configuration travels through stdin to a temporary helper that populates separate named volumes, not through host bind mounts. Keep the Xray private key out of Caddy's volume.

The initial Xray pin is `ghcr.io/xtls/xray-core:26.3.27@sha256:592ec4d11f656db95598d01e76dbcc6e002d67360b96a5436500a938230f52c7`, matching upstream's stable release label at review time. Newer pre-releases also exist; upgrades need native config and client tunnel tests. The Docker provider pin is `kreuzwerker/docker` 4.6.0. Caddy's reviewed upstream Alpine version is 2.11.4; resolve and pin its manifest digest before production too.

| External endpoint | Container destination | Purpose |
| --- | --- | --- |
| TCP 443 | Xray 8443 | VLESS + REALITY + Vision, or ordinary TLS forwarded to Caddy |
| TCP 80 | Caddy 8080 | ACME HTTP-01 and HTTPS redirect |
| Not published | Caddy 8443 | Own HTTPS target behind REALITY |

Xray must resolve `caddy` on its container network. `127.0.0.1` in separate containers refers to different network namespaces. Run both services as UID/GID 65532. Seed config directories as 0750 and config files as 0400 owned by that UID; mount each service's own volume read-only at `/etc/config-v`. Xray's official image has `/usr/local/bin/xray` as its entrypoint: set arguments `run -config /etc/config-v/xray.json`, overriding its bundled config directory. Caddy uses `caddy run --config /etc/config-v/Caddyfile --adapter caddyfile`, with persistent `/data` and `/config` writable by UID 65532. Its Alpine binary has a file capability; remove it when building the derived image so high-port operation can use all capabilities dropped. All container listen ports exceed 1024. Publishing external 80/443 using a rootless runtime still requires a deliberate host-level solution.

Caddy uses HTTP-01 to obtain and renew a real certificate: TCP 80 must reach Caddy before testing REALITY. HTTP/3 is disabled because this design forwards TCP. The HTTPS handler is a minimal response; the analytics website is deferred. A normal browser TLS handshake can reach that response, but malformed traffic is not guaranteed to render a page. A working website alone does not prove that the VPN tunnel works.

`Caddyfile.local.example` uses Caddy's internal CA and the generated local domain (default `vpn.test`), never a public certificate. Publish local ports on 127.0.0.1 only. A browser will not trust that CA by default; use its exported root explicitly for a local TLS check rather than changing the host trust store. A local-only `curl -k` check is also possible but does not validate certificate trust. Local plumbing tests do not validate public ACME issuance or resistance to filtering. Test a real client tunnel separately; do not disable certificate checks in production clients.

The REALITY client needs its individual UUID, server address/port, `security=reality`, `type=tcp`, `flow=xtls-rprx-vision`, `fp=chrome`, the matching `sni`, public key (`pbk`), and short ID (`sid`). The server private key is never included in the client URI. These fields are supported by the pinned Xray version; support in each mobile/desktop app depends on its bundled core version.

Access logs, metrics, user traffic counters, and management APIs are disabled by default. Warning logs can still contain operational details; apply bounded retention. The routing example blocks common private/loopback destinations for tunnel clients. Deployment must also isolate service networks and check that clients cannot reach host metadata or internal service ports.

To add aggregate traffic metrics later, explicitly add this top-level configuration to a private Xray config:

```json
{
  "stats": {},
  "metrics": { "listen": "0.0.0.0:11111" },
  "policy": {
    "system": {
      "statsInboundUplink": true,
      "statsInboundDownlink": true
    }
  }
}
```

Port 11111 must remain unpublished on an isolated service network accessible only to the authenticated backend's collector. For a collector in the same network namespace, prefer `127.0.0.1:11111`. The listener has no authentication and also exposes profiling endpoints. Never proxy `/debug/vars` or `/debug/pprof` to public routes. Read only `stats.inbound.family.uplink` and `.downlink`; counters reset on process restart and do not measure uptime, active connections, or reachability from relatives' operators. Do not add inbound and outbound totals together or return raw responses in a public API.
