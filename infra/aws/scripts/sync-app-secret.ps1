# =============================================================================
# Sync the local Azure + web-search credentials into AWS Secrets Manager
# (secret: auxify-prod/app). The ECS task reads this at runtime, so no secret
# values live in the task definition or in source control.
#
# Usage:  pwsh infra/aws/scripts/sync-app-secret.ps1
# Reads:  infra/azure/azure-credentials.env
# =============================================================================

$ErrorActionPreference = "Stop"
$aws = "$env:LOCALAPPDATA\Programs\Amazon\AWSCLIV2\aws.exe"
$envFile = Join-Path $PSScriptRoot "..\..\azure\azure-credentials.env"
$secretId = "auxify-prod/app"
$region = "ap-south-1"
$profile = "auxify"

if (-not (Test-Path $envFile)) { throw "Credentials file not found: $envFile" }

# Parse KEY=VALUE lines (ignore comments / blanks). Strip inline comments.
$map = @{}
Get-Content $envFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -eq "" -or $line.StartsWith("#")) { return }
  $idx = $line.IndexOf("=")
  if ($idx -lt 1) { return }
  $key = $line.Substring(0, $idx).Trim()
  $val = $line.Substring($idx + 1).Trim()
  # remove trailing inline comment ("value   # note")
  $hash = $val.IndexOf("  #")
  if ($hash -gt 0) { $val = $val.Substring(0, $hash).Trim() }
  $map[$key] = $val
}

$payload = $map | ConvertTo-Json -Depth 3
$tmp = Join-Path $env:TEMP "auxify-app-secret.json"
Set-Content -Path $tmp -Value $payload -Encoding utf8

& $aws secretsmanager put-secret-value `
  --secret-id $secretId `
  --secret-string "file://$tmp" `
  --profile $profile --region $region | Out-Null

Remove-Item $tmp -Force
Write-Output "Synced $($map.Count) keys into Secrets Manager secret '$secretId'."
