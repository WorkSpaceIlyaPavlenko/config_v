output "node_name" {
  description = "Node identifier."
  value       = var.node_name
}

output "ports" {
  description = "Published addresses on the Docker host; Colima forwards local TCP ports to macOS."
  value = {
    bind_address = var.bind_address
    vpn_tcp      = var.vpn_port
    http_tcp     = var.http_port
  }
}

output "containers" {
  description = "Container names for explicit operational commands."
  value = {
    xray  = docker_container.xray.name
    caddy = docker_container.caddy.name
  }
}

output "config_volumes" {
  description = "Separate externally seeded configuration volumes. Values are names only."
  value = {
    xray  = local.xray_config_volume
    caddy = local.caddy_config_volume
  }
}

output "persistent_volumes" {
  description = "Certificate storage and Caddy runtime storage; back up outside this node."
  value = {
    data    = docker_volume.caddy_data.name
    runtime = docker_volume.caddy_runtime.name
  }
}
