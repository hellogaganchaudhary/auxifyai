# =============================================================================
# Network module — VPC spanning MULTIPLE Availability Zones.
#
# Provisions public + private subnets across >= 2 AZs, an Internet Gateway,
# NAT gateway(s), and route tables. Region- and AZ-agnostic: the region comes
# from the provider configured in the calling environment, and AZs are either
# passed in explicitly or auto-discovered. This is what makes the same module
# deployable to additional regions without redesign (Req 42.3) while removing
# single points of failure (Req 39.5).
# =============================================================================

# Auto-discover standard AZs when an explicit list is not supplied. Excludes
# Local Zones / Wavelength which don't support NAT Gateway or ElastiCache.
data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }

  filter {
    name   = "zone-type"
    values = ["availability-zone"]
  }
}

locals {
  # Prefer the explicit AZ list; otherwise slice the discovered AZs.
  azs = length(var.availability_zones) > 0 ? slice(var.availability_zones, 0, var.az_count) : slice(data.aws_availability_zones.available.names, 0, var.az_count)

  # /20 public + /20 private per AZ derived from the VPC /16 when CIDRs aren't
  # supplied explicitly.
  public_subnets  = length(var.public_subnet_cidrs) > 0 ? var.public_subnet_cidrs : [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i)]
  private_subnets = length(var.private_subnet_cidrs) > 0 ? var.private_subnet_cidrs : [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i + 8)]

  # One NAT per AZ for full HA, or a single shared NAT for cost savings.
  nat_gateway_count = var.single_nat_gateway ? 1 : var.az_count
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.tags, { Name = "${var.name}-vpc" })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = merge(var.tags, { Name = "${var.name}-igw" })
}

resource "aws_subnet" "public" {
  count                   = var.az_count
  vpc_id                  = aws_vpc.main.id
  cidr_block              = local.public_subnets[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true

  tags = merge(var.tags, {
    Name = "${var.name}-public-${local.azs[count.index]}"
    Tier = "public"
  })
}

resource "aws_subnet" "private" {
  count             = var.az_count
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.private_subnets[count.index]
  availability_zone = local.azs[count.index]

  tags = merge(var.tags, {
    Name = "${var.name}-private-${local.azs[count.index]}"
    Tier = "private"
  })
}

resource "aws_eip" "nat" {
  count  = local.nat_gateway_count
  domain = "vpc"
  tags   = merge(var.tags, { Name = "${var.name}-nat-eip-${count.index}" })
}

resource "aws_nat_gateway" "main" {
  count         = local.nat_gateway_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = merge(var.tags, { Name = "${var.name}-nat-${count.index}" })

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = merge(var.tags, { Name = "${var.name}-public-rt" })
}

# One private route table per AZ so each AZ's egress can target its own NAT
# (full HA) or all share the single NAT (cost mode).
resource "aws_route_table" "private" {
  count  = var.az_count
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = var.single_nat_gateway ? aws_nat_gateway.main[0].id : aws_nat_gateway.main[count.index].id
  }

  tags = merge(var.tags, { Name = "${var.name}-private-rt-${local.azs[count.index]}" })
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}
