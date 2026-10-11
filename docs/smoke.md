# Local tunnel smoke test

After generating, seeding, and applying a **local** node:

```sh
node tools/smoke.mjs --node local-check
```

The test refuses production nodes and uses only the dedicated `config-v` Colima socket. It checks the ordinary HTTPS fallback on the Mac's loopback port, then runs a temporary Xray client and sends a certificate-verified HTTPS request through its SOCKS proxy to `https://example.com/`. A second client with an unknown UUID must fail; a subsequent valid-client request confirms the target is still reachable.

The fallback check accepts the local Caddy certificate only in this local mode. The proxied public HTTPS request always verifies its certificate. No temporary SOCKS port is published. Client credentials travel through stdin, with no host mount, environment secret, command-line secret, or Terraform state entry. The pinned Xray version supports [`-config stdin:`](https://github.com/XTLS/Xray-core/blob/v26.3.27/main/run.go). The curl probe reuses the running Caddy container's immutable image ID, which includes curl, so it needs no extra image download.

Output contains pass/fail status, not response bodies, IP addresses, or credentials. Cleanup removes only containers bearing this invocation's random ownership label, including their anonymous volumes. SIGINT/SIGTERM trigger cleanup; an OS crash or SIGKILL can leave temporary containers requiring removal by their `io.config-v.smoke` label. The test does not remove service containers, configurations, or persistent certificate volumes.

This checks actual local protocol behavior, not censorship resistance, production certificate renewal, device-wide DNS/IPv6 handling, or availability from relatives' networks. The public test site must be reachable through the server for a successful result.
