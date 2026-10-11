variable "node_name" {
  description = "Node identifier. Each node must use its own Terraform state."
  type        = string
  default     = "local"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,31}$", var.node_name))
    error_message = "node_name must contain 1–32 lowercase letters, numbers or hyphens, beginning with a letter."
  }
}

variable "bind_address" {
  description = "Host IPv4 address for published ports. Local development binds loopback; 0.0.0.0 explicitly exposes the node."
  type        = string
  default     = "127.0.0.1"

  validation {
    condition     = can(cidrnetmask("${var.bind_address}/32"))
    error_message = "bind_address must be an IPv4 address."
  }
}

variable "image_platform" {
  description = "Target Docker daemon platform, discovered by the deployment CLI; do not infer it from the Terraform laptop."
  type        = string

  validation {
    condition     = contains(["linux/amd64", "linux/arm64"], var.image_platform)
    error_message = "image_platform must be linux/amd64 or linux/arm64."
  }
}

variable "dns_servers" {
  description = "Upstream IPv4/IPv6 DNS resolvers for both containers. Empty uses the Docker host defaults; this does not create public DNS records."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for address in var.dns_servers : !strcontains(address, "/") && (can(cidrhost("${address}/32", 0)) || can(cidrhost("${address}/128", 0)))])
    error_message = "dns_servers must contain IPv4 or IPv6 address literals without CIDR prefixes."
  }
}

variable "vpn_port" {
  description = "Host TCP port forwarded to Xray TCP 8443. Set to 443 on the production node."
  type        = number
  default     = 8443

  validation {
    condition     = var.vpn_port >= 1 && var.vpn_port <= 65535 && floor(var.vpn_port) == var.vpn_port
    error_message = "vpn_port must be an integer between 1 and 65535."
  }
}

variable "http_port" {
  description = "Host TCP port forwarded to Caddy TCP 8080. Set to 80 for public ACME HTTP challenges."
  type        = number
  default     = 8080

  validation {
    condition     = var.http_port >= 1 && var.http_port <= 65535 && floor(var.http_port) == var.http_port
    error_message = "http_port must be an integer between 1 and 65535."
  }
}

variable "xray_image" {
  description = "Explicit Xray release image or immutable digest; update deliberately after a tunnel test."
  type        = string
  default     = "ghcr.io/xtls/xray-core:26.3.27@sha256:592ec4d11f656db95598d01e76dbcc6e002d67360b96a5436500a938230f52c7"

  validation {
    condition     = can(regex("(:[0-9]+\\.[0-9]+\\.[0-9]+|@sha256:[0-9a-f]{64})$", var.xray_image))
    error_message = "xray_image must use a full numerical version tag or sha256 digest; floating tags are not allowed."
  }
}

variable "caddy_base_image" {
  description = "Official Caddy Alpine base for the small non-root image built by Terraform."
  type        = string
  default     = "caddy:2.11.4-alpine"

  validation {
    condition     = can(regex("(:[0-9]+\\.[0-9]+\\.[0-9]+-alpine|@sha256:[0-9a-f]{64})$", var.caddy_base_image))
    error_message = "caddy_base_image must use a complete Alpine version tag or an immutable sha256 digest."
  }
}

variable "config_revision" {
  description = "Non-secret deployment revision. Change after seeding updated configuration to recreate the containers. Never put key material in this value."
  type        = string
  default     = "initial"

  validation {
    condition     = can(regex("^[a-zA-Z0-9._-]{1,64}$", var.config_revision))
    error_message = "config_revision must be a short public deployment identifier."
  }
}

variable "xray_memory_mb" {
  description = "Xray hard memory limit in MiB."
  type        = number
  default     = 256

  validation {
    condition     = var.xray_memory_mb >= 64 && floor(var.xray_memory_mb) == var.xray_memory_mb
    error_message = "Allocate at least 64 MiB to Xray."
  }
}

variable "caddy_memory_mb" {
  description = "Caddy hard memory limit in MiB."
  type        = number
  default     = 128

  validation {
    condition     = var.caddy_memory_mb >= 64 && floor(var.caddy_memory_mb) == var.caddy_memory_mb
    error_message = "Allocate at least 64 MiB to Caddy."
  }
}

variable "xray_cpus" {
  description = "Maximum CPU cores available to Xray."
  type        = number
  default     = 1

  validation {
    condition     = var.xray_cpus > 0
    error_message = "xray_cpus must be positive."
  }
}

variable "caddy_cpus" {
  description = "Maximum CPU cores available to Caddy."
  type        = number
  default     = 0.5

  validation {
    condition     = var.caddy_cpus > 0
    error_message = "caddy_cpus must be positive."
  }
}
