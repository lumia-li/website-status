#Requires -Version 5.1
<#
  查看邮件订阅者列表
  用法（在 cloudflare 目录执行）：
      powershell -ExecutionPolicy Bypass -File .\subscribers.ps1                  # 全部
      powershell -ExecutionPolicy Bypass -File .\subscribers.ps1 -OnlyVerified    # 只看已确认
      powershell -ExecutionPolicy Bypass -File .\subscribers.ps1 -Csv             # 导出 CSV
#>
param([switch]$Csv, [switch]$OnlyVerified)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$sql = "SELECT email, verified, lang, created_at, verified_at FROM subscribers"
if ($OnlyVerified) { $sql += " WHERE verified=1" }
$sql += " ORDER BY created_at DESC"

$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$raw = & npx --yes wrangler d1 execute DB --remote --command $sql --json 2>$null | Out-String
$code = $LASTEXITCODE
$ErrorActionPreference = $prevEap

# 只认 JSON 数组的起点，避开 stderr 里的 [WARNING] 之类
$match = [regex]::Match($raw, '\[\s*\{')
if ($match.Success) {
    $start = $match.Index
} else {
    $start = $raw.IndexOf('[')
}
$end = $raw.LastIndexOf(']')

if ($code -ne 0 -or $start -lt 0 -or $end -le $start) {
    Write-Host "查询失败，原始输出：" -ForegroundColor Red
    Write-Host $raw -ForegroundColor DarkGray
    exit 1
}

$parsed = $raw.Substring($start, $end - $start + 1) | ConvertFrom-Json
$rows = $parsed[0].results

if (-not $rows -or $rows.Count -eq 0) {
    Write-Host "暂无订阅者" -ForegroundColor Yellow
    return
}

if ($Csv) {
    $out = Join-Path $PSScriptRoot "subscribers.csv"
    $rows | Select-Object email, verified, lang, created_at, verified_at |
        Export-Csv -Path $out -NoTypeInformation -Encoding UTF8
    Write-Host "已导出 $($rows.Count) 条到 $out" -ForegroundColor Green
    return
}

$table = @()
foreach ($row in $rows) {
    if ($row.verified -eq 1) { $state = "已确认" } else { $state = "待确认" }
    if ($row.verified_at) { $okAt = $row.verified_at } else { $okAt = "-" }
    $table += [PSCustomObject]@{
        "邮箱"     = $row.email
        "状态"     = $state
        "语言"     = $row.lang
        "订阅时间" = $row.created_at
        "确认时间" = $okAt
    }
}

$confirmed = ($rows | Where-Object { $_.verified -eq 1 }).Count
Write-Host ""
Write-Host "共 $($rows.Count) 条记录（已确认 $confirmed 条）" -ForegroundColor Cyan
$table | Format-Table -AutoSize | Out-String -Width 220 | Write-Host
