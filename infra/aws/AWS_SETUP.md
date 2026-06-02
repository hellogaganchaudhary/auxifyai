# Auxify AI — AWS Provisioning (Status)

**Account:** `203994908933`  ·  IAM user `auxifyai` (AdministratorAccess)
**Region:** `ap-south-1` (Mumbai)
**CLI profile:** `auxify` (configured locally; credentials not committed)
**IaC:** Terraform in `infra/aws/terraform/` — fully reversible via `terraform destroy`.

## ✅ LIVE — provisioned and verified (54 resources, apply succeeded)

| Output | Value |
|--------|-------|
| ALB DNS | `auxify-prod-alb-569186497.ap-south-1.elb.amazonaws.com` |
| RDS endpoint | `auxify-prod-pg.ctyae428muyp.ap-south-1.rds.amazonaws.com` (PostgreSQL 16.14, Multi-AZ, **available**) |
| Redis endpoint | `master.auxify-prod-redis.cjakkj.aps1.cache.amazonaws.com` |
| ECR repo | `203994908933.dkr.ecr.ap-south-1.amazonaws.com/auxify-prod/api` |
| ECS cluster | `auxify-prod-cluster` (service ACTIVE, 0/2 tasks — waiting for image) |
| S3 bucket | `auxify-prod-files-45474ae1` |
| VPC | `vpc-03dfaad8d32d187fd` (subnets in ap-south-1a / 1b) |
| KMS key | `arn:aws:kms:ap-south-1:203994908933:key/147a9563-...` |
| Secrets | `auxify-prod/database`, `auxify-prod/redis`, `auxify-prod/app` (35 keys synced) |

> The ECS service runs 0 tasks until the API container image is pushed to ECR — that's the
> application build phase, not infra. The service auto-launches tasks once `:latest` exists.


---

## What gets created (54 resources)

| Layer | Resources |
|-------|-----------|
| **Network** | VPC `10.20.0.0/16`, 2× public + 2× private subnets, IGW, NAT GW, route tables |
| **Security** | 4 security groups (ALB → ECS → RDS/Redis), least-privilege chained |
| **Database** | RDS **PostgreSQL 16.14** (Multi-AZ, gp3, KMS-encrypted, 14-day backups, deletion protection), **pgvector** preloaded |
| **Cache** | ElastiCache **Redis 7.1** (replication group, at-rest+transit encryption, AUTH token) |
| **Compute** | ECS **Fargate** cluster, API task def, service (2 tasks → autoscale 6 on CPU) |
| **Ingress** | **ALB** (HTTP:80; HTTPS block ready to enable with ACM cert) |
| **Registry** | **ECR** repo `auxify/api` (scan-on-push, KMS, keep last 15 images) |
| **Storage** | **S3** files bucket (versioned, KMS, public access blocked, lifecycle rules) |
| **Secrets** | Secrets Manager: `auxify/database`, `auxify/redis`, `auxify/app` |
| **Crypto** | KMS customer-managed key (auto-rotation) + alias |
| **Observability** | CloudWatch log group, Container Insights |
| **IAM** | ECS execution role + task role (Bedrock invoke, S3, Secrets, KMS only) |

## Bedrock (Claude) — verified working in Mumbai

Model access enabled; `claude-3-haiku` invocation tested ✅. Models wired into the API task env:

| Logical | Model ID |
|---------|----------|
| Opus | `anthropic.claude-opus-4-5-20251101-v1:0` |
| Sonnet | `anthropic.claude-sonnet-4-5-20250929-v1:0` |
| Haiku | `anthropic.claude-haiku-4-5-20251001-v1:0` |

> Newer IDs exist in-region too (e.g. `claude-opus-4-6`, `claude-sonnet-4-6`). Swap via the
> `bedrock_models` variable in `terraform.tfvars` — no code change needed.

---

## RAG / "complete memory" design

The requirement: the platform never forgets — every chat, document, and piece of org knowledge
stays retrievable and grounds future answers. Implemented as a layered memory:

1. **System of record (Postgres):** all conversations, messages, documents, knowledge pages are
   persisted permanently in RDS. Nothing is discarded.
2. **Vector memory (pgvector on the same RDS):** every message, file chunk, and knowledge page is
   embedded (Azure `text-embedding-3-large`) and stored as a `vector`. Retrieval = hybrid semantic
   (pgvector cosine/HNSW) + keyword (Postgres FTS).
3. **Hot memory (Redis):** recent context, session state, and dedup cache for fast recall.
4. **File store (S3):** original uploaded artifacts, retained and re-embeddable.

Because embeddings live in the same Postgres as the relational data, every retrieval is
permission-filtered (org/team/project) and every answer can cite its source. As the team adds
data, the platform re-embeds and indexes it, so it continuously "learns" the organization's
knowledge without retraining a base model. See `docs/rag-memory.md` (to be added with backend).

---

## Operate

```powershell
$tf  = "$env:LOCALAPPDATA\terraform\terraform.exe"
$aws = "C:\Users\<you>\AppData\Local\Programs\Amazon\AWSCLIV2\aws.exe"

# from infra/aws/terraform
& $tf output                 # show endpoints (ALB DNS, RDS, Redis, ECR, bucket)
& $tf plan                   # preview drift
& $tf destroy                # tear everything down (reversible)
```

### Cost note
Defaults are production-grade (~$300–500/mo on credits): RDS Multi-AZ + Redis replica + NAT +
2× Fargate running 24/7. For a cheaper dev run set `db_multi_az = false` in `terraform.tfvars`
(drops the RDS standby and Redis replica).

### To enable HTTPS
Request an ACM cert for your domain, then uncomment the `https` listener in `alb.tf`, set
`acm_certificate_arn`, and point your domain's DNS at the ALB `alb_dns_name` output.
