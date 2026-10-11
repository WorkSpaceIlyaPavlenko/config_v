locals {
  prefix = "config-v-${var.node_name}"

  # These volumes are seeded out of band. Private keys and UUIDs never enter
  # Terraform configuration, provider arguments, plans or state.
  xray_config_volume  = "${local.prefix}-xray-config"
  caddy_config_volume = "${local.prefix}-caddy-config"
  caddy_image_context = abspath("${path.module}/caddy-image")
  caddy_image_revision = sha256(join("", [
    var.caddy_base_image,
    var.image_platform,
    filesha256("${path.module}/caddy-image/Dockerfile"),
    filesha256("${path.module}/caddy-image/.dockerignore"),
  ]))
}

resource "terraform_data" "config_revision" {
  input = var.config_revision
}

resource "docker_network" "node" {
  name     = local.prefix
  driver   = "bridge"
  internal = false

  labels {
    label = "io.config-v.node"
    value = var.node_name
  }
}

resource "docker_volume" "caddy_data" {
  name = "${local.prefix}-caddy-data"

  lifecycle {
    prevent_destroy = true
  }
}

resource "docker_volume" "caddy_runtime" {
  name = "${local.prefix}-caddy-runtime"

  lifecycle {
    prevent_destroy = true
  }
}

resource "docker_image" "xray" {
  name         = var.xray_image
  platform     = var.image_platform
  keep_locally = true
}

resource "docker_image" "caddy" {
  name         = "config-v/caddy:${substr(local.caddy_image_revision, 0, 16)}"
  keep_locally = true

  build {
    context    = local.caddy_image_context
    dockerfile = "Dockerfile"
    platform   = var.image_platform

    # Use the explicitly configured provider daemon, without selecting an
    # unrelated local buildx builder or Docker context.
    use_legacy_builder = true
    build_args = {
      CADDY_BASE_IMAGE = var.caddy_base_image
    }
  }

  triggers = {
    revision = local.caddy_image_revision
  }
}

resource "docker_container" "caddy" {
  name    = "${local.prefix}-caddy"
  image   = docker_image.caddy.image_id
  command = ["caddy", "run", "--config", "/etc/config-v/Caddyfile", "--adapter", "caddyfile"]

  user          = "65532:65532"
  privileged    = false
  read_only     = true
  security_opts = ["no-new-privileges:true"]
  restart       = "unless-stopped"
  memory        = var.caddy_memory_mb
  memory_swap   = var.caddy_memory_mb
  cpus          = floor(var.caddy_cpus) == var.caddy_cpus ? format("%.1f", var.caddy_cpus) : tostring(var.caddy_cpus)
  ipc_mode      = "private"
  network_mode  = "bridge"
  dns           = var.dns_servers
  stop_timeout  = 15

  capabilities {
    drop = ["ALL"]
  }

  tmpfs = {
    "/tmp" = "rw,noexec,nosuid,nodev,size=16m,mode=1777"
  }

  networks_advanced {
    name    = docker_network.node.id
    aliases = ["caddy"]
  }

  # TLS 8443 is reachable only inside this network, through Xray's REALITY
  # target. The Caddy admin API and metrics have no published port.
  ports {
    internal = 8080
    external = var.http_port
    ip       = var.bind_address
    protocol = "tcp"
  }

  volumes {
    volume_name    = local.caddy_config_volume
    container_path = "/etc/config-v"
    read_only      = true
  }

  # Docker copies the image's UID 65532-owned directories into newly created
  # empty named volumes. Do not set volume-nocopy for these two mounts.
  volumes {
    volume_name    = docker_volume.caddy_data.name
    container_path = "/data"
  }

  volumes {
    volume_name    = docker_volume.caddy_runtime.name
    container_path = "/config"
  }

  log_driver = "json-file"
  log_opts = {
    "max-size" = "5m"
    "max-file" = "2"
  }

  labels {
    label = "io.config-v.node"
    value = var.node_name
  }

  lifecycle {
    replace_triggered_by = [terraform_data.config_revision]
    precondition {
      condition     = var.http_port != var.vpn_port
      error_message = "HTTP and VPN must use different host TCP ports."
    }
  }
}

resource "docker_container" "xray" {
  name    = "${local.prefix}-xray"
  image   = docker_image.xray.image_id
  command = ["run", "-config", "/etc/config-v/xray.json"]

  user          = "65532:65532"
  privileged    = false
  read_only     = true
  security_opts = ["no-new-privileges:true"]
  restart       = "unless-stopped"
  memory        = var.xray_memory_mb
  memory_swap   = var.xray_memory_mb
  cpus          = floor(var.xray_cpus) == var.xray_cpus ? format("%.1f", var.xray_cpus) : tostring(var.xray_cpus)
  ipc_mode      = "private"
  network_mode  = "bridge"
  dns           = var.dns_servers
  stop_timeout  = 15

  capabilities {
    drop = ["ALL"]
  }

  tmpfs = {
    "/tmp" = "rw,noexec,nosuid,nodev,size=16m,mode=1777"
  }

  networks_advanced {
    name    = docker_network.node.id
    aliases = ["xray"]
  }

  ports {
    internal = 8443
    external = var.vpn_port
    ip       = var.bind_address
    protocol = "tcp"
  }

  volumes {
    volume_name    = local.xray_config_volume
    container_path = "/etc/config-v"
    read_only      = true
  }

  log_driver = "json-file"
  log_opts = {
    "max-size" = "5m"
    "max-file" = "2"
  }

  labels {
    label = "io.config-v.node"
    value = var.node_name
  }

  depends_on = [docker_container.caddy]

  lifecycle {
    replace_triggered_by = [terraform_data.config_revision]
  }
}
