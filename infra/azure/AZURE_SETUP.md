# Auxify AI — Azure Provisioning (Status)

**Subscription:** Microsoft Azure Sponsorship (`7929d7f2-0764-410e-bfaa-788c7fa40015`)
**Tenant:** `3b97e837-54ef-47d8-b63d-ca80218949eb` (collegese.com)
**Resource Group:** `gaganai` — region `eastus`
**Constraint honored:** everything created inside `gaganai` only. Nothing outside it was touched.

Secrets (endpoints + keys) live in `infra/azure/azure-credentials.env` (gitignored).

---

## 1. Azure OpenAI account — `auxify-openai-eastus`

Endpoint: `https://auxify-openai-eastus.openai.azure.com/`
API version: `2024-10-21`

| Deployment | Backing model | Tier | SKU | State |
|------------|--------------|------|-----|-------|
| `gpt-4o` | gpt-4o (2024-11-20) | Standard | 30K TPM | ✅ |
| `gpt-4o-mini` | gpt-4.1-mini (2025-04-14) | Economy | 30K TPM | ✅ |
| `o3` | o3 (2025-04-16) | Premium reasoning | 30K TPM | ✅ |
| `o4-mini` | o4-mini (2025-04-16) | Economy reasoning | 30K TPM | ✅ |
| `gpt-5` | gpt-5 (2025-08-07) | GlobalStandard | 30K TPM | ✅ |
| `gpt-5-pro` | gpt-5-pro (2025-10-06) | GlobalStandard | 30K TPM | ✅ |
| `gpt-5.4` | gpt-5.4 (2026-03-05) | GlobalStandard | 30K TPM | ✅ |
| `gpt-5.5` | gpt-5.5 (2026-04-24) | GlobalProvisionedManaged (PTU) | 15 PTU | ✅ |
| `text-embedding-3-large` | embedding | Standard | 50K TPM | ✅ |

**Call shape:**
`POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=2024-10-21`
Header: `api-key: <AZURE_OPENAI_API_KEY>`

### Substitutions / notes
- **`gpt-4o-mini`** original version (2024-07-18) was **deprecated by Microsoft on 2026-03-31** in eastus.
  Deployment name kept as `gpt-4o-mini` but backed by **gpt-4.1-mini** so app code needs no change.
- **"GPT 5.4 Pro"** does not exist as a model. The Pro model is **gpt-5-pro** (GPT-5 Pro), deployed as `gpt-5-pro`.
- **`gpt-5.5`** is **ProvisionedManaged only** (no pay-go SKU). Deployed on 15 PTU. PTU reserves
  throughput and is the most expensive line item — scale `gpt-5.5` capacity down/delete if cost matters.

---

## 1b. Azure OpenAI account #2 — `auxify-openai-eastus2` (image + realtime)

Created in **eastus2** because eastus does not carry the image/realtime models.
Endpoint: `https://auxify-openai-eastus2.openai.azure.com/`
API version: `2025-04-01-preview`

| Deployment | Backing model | Purpose | SKU | State |
|------------|--------------|---------|-----|-------|
| `gpt-image-2` | gpt-image-2 (2026-04-21) | Image generation (upgraded) | GlobalStandard | ✅ |
| `gpt-realtime` | gpt-realtime-1.5 (2026-02-23) | Realtime audio/voice (upgraded) | GlobalStandard | ✅ |

- **Image** call: `POST {endpoint}/openai/deployments/gpt-image-2/images/generations?api-version=2025-04-01-preview` — smoke-tested ✅
- **Realtime** uses the realtime/websocket endpoint with deployment `gpt-realtime`.

### Substitution note
- Target `gpt-realtime-2` (2026-05-06) had **0 free RPM quota** in both eastus2 and swedencentral
  (the 10 RPM limit is fully consumed by other Cognitive accounts already in the subscription —
  not reclaimed to avoid touching resources outside this work). Deployed **gpt-realtime-1.5**, the
  newest realtime model with available quota, under the deployment name `gpt-realtime`.

---

## 2. Azure AI Foundry account — `auxify-foundry-eastus`

Hosts partner / Models-as-a-Service models (not OpenAI-kind).

Endpoint: `https://auxify-foundry-eastus.services.ai.azure.com/`
Inference base: `https://auxify-foundry-eastus.services.ai.azure.com/models`
API version: `2024-05-01-preview`

| Deployment | Publisher | SKU | State |
|------------|-----------|-----|-------|
| `grok-4.3` | xAI | GlobalStandard | ✅ |
| `grok-4-20-reasoning` | xAI | GlobalStandard | ✅ |
| `DeepSeek-V3.1` | DeepSeek | GlobalStandard | ✅ |
| `DeepSeek-R1-0528` | DeepSeek | GlobalStandard | ✅ |
| `Kimi-K2.6` | Moonshot AI | GlobalStandard | ✅ |

**Call shape (unified Foundry inference):**
`POST {inference_base}/chat/completions?api-version=2024-05-01-preview`
Header: `api-key: <AZURE_FOUNDRY_API_KEY>` · Body includes `"model": "<deployment>"`

### Not deployed
- **Kimi-K2-Thinking** — deprecated by Microsoft 2026-03-29. Superseded by `Kimi-K2.6` (deployed).

---

## 3. Web search / scraping — NOT an Azure resource

The plan originally specified **Azure Bing Search (S2)**, but Microsoft **retired the standalone
Bing Search APIs on 2025-08-11**. The replacement, **Grounding with Bing Search**, returned
`SkuNotEligible` on this Sponsorship subscription (both G1 and S1), so Bing is not usable here.

Instead, web search/scrape uses a **multi-provider rotation layer** (see
`apps/api/src/modules/search/`) across the six providers you chose. Rotation spreads requests
across providers to maximize free-tier usage and fails over on rate-limit/error.

**Status:** 4 of 6 providers keyed and active — **Serper, WebSearchAPI.ai, Firecrawl, Exa**.
Brave and Tavily are wired in code but left without keys, so the rotation skips them.

| Provider | Search | Scrape | Key set | Notes |
|----------|:------:|:------:|:-------:|-------|
| Serper.dev | ✅ | ✅ | ✅ | Google SERP + scrape endpoint |
| WebSearchAPI.ai | ✅ | — | ✅ | confirm base path in dashboard |
| Firecrawl.dev | ✅ | ✅ | ✅ | scraping-first; best as primary scraper |
| Exa.ai | ✅ | ✅ | ✅ | neural/semantic search |
| Brave Search | ✅ | — | — | not keyed (skipped) |
| Tavily.com | ✅ | ✅ | — | not keyed (skipped) |

**Action required from you:** sign up for each and paste the API keys into
`infra/azure/azure-credentials.env`. Only providers with a key become active in the rotation.

### How rotation works
- Round-robin cursor advances every call → consecutive requests hit different providers.
- A `429` puts that provider on a timed cooldown; the request fails over to the next one.
- `search` requests only go to providers that support the requested search type.
- `scrape` requests only go to scrape-capable providers (Serper, Firecrawl, Exa, Tavily).

---

## Reproduce / manage (CLI)

All commands run via the Azure CLI logged in as `ceo@nxthubconsulting.com`.

```powershell
# list deployments
az cognitiveservices account deployment list -n auxify-openai-eastus  -g gaganai -o table
az cognitiveservices account deployment list -n auxify-foundry-eastus -g gaganai -o table

# rotate / read keys
az cognitiveservices account keys list -n auxify-openai-eastus  -g gaganai
az cognitiveservices account keys list -n auxify-foundry-eastus -g gaganai
```
