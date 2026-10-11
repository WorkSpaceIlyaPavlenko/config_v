# VPN architecture

The first step is the VPN service. The website and dashboard are deferred. `deploy/templates/` contains Xray/Caddy templates; the CLI produces private `runtime/<node>/` files and seeds named Docker volumes through stdin. Terraform defines service resources without receiving private key material. No VPS has been deployed or provisioned by creating these files.

```text
Browser / VPN client → VPS TCP 443 → Xray:8443
                                      ├─ authenticated VLESS + REALITY + Vision → Internet
                                      └─ ordinary TLS → Caddy:8443
ACME / HTTP client  → VPS TCP 80  → Caddy:8080
```

Caddy owns the domain's TLS certificate and renews it through HTTP-01. The Xray target is the private Caddy address, not the public domain resolving back to Xray. REALITY's TLS forwarding gives browsers a normal HTTPS response; it does not guarantee invisibility or availability if an IP, ASN, domain, or transport is blocked. Metrics and user statistics are off by default.

## Local Colima profile

`sh scripts/colima-profile.sh` creates a dedicated `~/.colima/config-v/colima.yaml` and refuses to overwrite an existing profile. It neither starts a VM nor installs software. Review the configuration, then explicitly run `colima start --profile config-v`. It disables host mounts (`mounts: null`), SSH agent forwarding, Kubernetes, and automatic context changes. In Colima, `mounts: []` instead enables the default writable home mount.

`sh scripts/colima-docker.sh` fixes the Docker daemon to the absolute `~/.colima/config-v/docker.sock` path and removes ambient context overrides without changing the user's active Docker context. The local Terraform workflow must use the same daemon. Build context can travel through the API without host mounts. Runtime containers use non-root UID/GID 65532, a read-only filesystem where possible, dropped capabilities, no new privileges, bounded logs, and resource limits. Do not mount a host home directory or Docker socket into them. Colima adds a VM boundary; Docker daemon access still controls that VM.

The VPS runtime remains undecided. Linux Colima needs available virtualization and enough resources. Rootless containers reduce privileges but do not add a separate kernel. Do not install rootful Docker on the VPS by default.

## Failure recovery

One VPS remains one point of failure. A chain of two VPS fails when either hop fails. Practical failover needs two independently reachable endpoints, preferably on different providers/networks, already cached in clients before an incident. Existing calls may break when switching.

Terraform reproduces resources when executed; it does not monitor connectivity or initiate recovery by itself. A Docker restart policy handles process exit; an unhealthy healthcheck alone does not restart a standalone container. A later workflow should create a replacement, test the site and an actual HTTPS request through the tunnel, distribute the endpoint, then retire the old node. Test from actual user networks; one local outage must not cause a global rebuild.

Keep encrypted off-host backups of keys, credentials, configurations, and state. Terraform `sensitive` redacts output but does not encrypt stored state. Kubernetes is unnecessary for this initial two-endpoint design.

## Primary references

- [Colima configuration](https://colima.run/docs/configuration/) and [mount handling in source](https://github.com/abiosoft/colima/blob/main/environment/vm/lima/yaml.go).
- [Terraform Docker provider](https://github.com/kreuzwerker/terraform-provider-docker/blob/master/docs/index.md) and [image build context](https://github.com/kreuzwerker/terraform-provider-docker/blob/master/docs/resources/image.md).
- [Xray REALITY](https://xtls.github.io/en/config/transports/reality.html), [statistics](https://xtls.github.io/en/config/stats.html), [metrics](https://xtls.github.io/en/config/metrics.html), and [metrics implementation](https://github.com/XTLS/Xray-core/blob/main/app/metrics/metrics.go).
- [Xray 26.3.27 image manifest](https://github.com/orgs/XTLS/packages/container/xray-core/762728764?tag=26.3.27), [release status](https://github.com/XTLS/Xray-core/releases/tag/v26.3.27), [Xray Dockerfile](https://github.com/XTLS/Xray-core/blob/v26.3.27/.github/docker/Dockerfile), and [Caddy Dockerfile](https://github.com/caddyserver/caddy-docker/blob/master/2.11/alpine/Dockerfile).
- [Caddy listener ports and HTTP protocols](https://caddyserver.com/docs/caddyfile/options) and [ACME configuration](https://caddyserver.com/docs/caddyfile/directives/tls).
- [Docker daemon access](https://docs.docker.com/engine/security/protect-access/), [rootless mode](https://docs.docker.com/engine/security/rootless/), and [restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/).
- [Terraform sensitive data](https://developer.hashicorp.com/terraform/language/manage-sensitive-data).
