output "vpc_id" {
  description = "ID of the VPC."
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "CIDR block of the VPC."
  value       = aws_vpc.main.cidr_block
}

output "availability_zones" {
  description = "Availability Zones the network spans (>= 2 for HA)."
  value       = local.azs
}

output "public_subnet_ids" {
  description = "IDs of the public subnets (one per AZ) — used by the ALB."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of the private subnets (one per AZ) — used by ECS, RDS, Redis."
  value       = aws_subnet.private[*].id
}

output "nat_gateway_ids" {
  description = "IDs of the NAT gateway(s) providing private-subnet egress."
  value       = aws_nat_gateway.main[*].id
}
