#Requires -Version 5.1
<#
  Liyue Status - 邮件订阅后端一键配置脚本
  用法：在 cloudflare 目录执行
      powershell -ExecutionPolicy Bypass -File .\setup.ps1

  脚本会依次完成：
    1. 登录 Cloudflare
    2. 创建/复用 D1 数据库并写入 wrangler.toml
    3. 初始化数据库表结构
    4. 预部署 Worker（让 secret put 有目标）
    5. 写入 SMTP 等 secrets
    6. 正式部署 Worker
    7. 把 Worker 地址回填到 ../assets/app.js 并刷新 index.html 缓存版本号 + 健康检查
#>

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$DbName       = "airliny-status-subscriptions"
$WorkerName   = "airliny-status-subscriptions"
$DefaultSite  = "https://status.liyueovo.top"
$TomlPath     = Join-Path $PSScriptRoot "wrangler.toml"
$AppJsPath    = Join-Path $PSScriptRoot "..\assets\app.js"
$IndexHtml    = Join-Path $PSScriptRoot "..\index.html"

function Step($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    [OK] $m" -ForegroundColor Green }
function Info($m) { Write-Host "    $m" -ForegroundColor Gray }
function Warn($m) { Write-Host "    [!] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "    [X] $m" -ForegroundColor Red; exit 1 }

function Run-Wrangler {
    param([string[]]$WArgs, [switch]$AllowFail)
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = & npx --yes wrangler @WArgs 2>&1 | Out-String
        $script:WranglerExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    if (-not $AllowFail -and $script:WranglerExitCode -ne 0) {
        Write-Host $out -ForegroundColor DarkGray
        Die "wrangler $($WArgs -join ' ') 执行失败（exit $script:WranglerExitCode）"
    }
    return $out
}

function Ask-Value {
    param([string]$Label, [string]$Default = "", [switch]$AllowSkip)
    if ($AllowSkip) {
        $v = Read-Host "$Label（回车 = 保留已有值）"
        if ([string]::IsNullOrWhiteSpace($v)) { return $null }
        return $v.Trim()
    }
    if ($Default) {
        $v = Read-Host "$Label（默认 $Default）"
        if ([string]::IsNullOrWhiteSpace($v)) { return $Default }
        return $v.Trim()
    }
    return (Read-Host $Label).Trim()
}

function Set-DatabaseId {
    param([string]$DbId)
    if (-not (Test-Path $TomlPath)) { Die "找不到 wrangler.toml" }
    $toml = Get-Content $TomlPath -Raw -Encoding UTF8
    if ($toml -match 'database_id\s*=\s*"[^"]*"') {
        $toml = [regex]::Replace($toml, 'database_id\s*=\s*"[^"]*"', "database_id = `"$DbId`"")
    } else {
        $toml = $toml -replace '(\[\[d1_databases\]\])', "`$1`n database_id = `"$DbId`""
    }
    [System.IO.File]::WriteAllText($TomlPath, $toml, (New-Object System.Text.UTF8Encoding($false)))
    Ok "wrangler.toml 的 database_id 已写入：$DbId"
}

function Set-Secret {
    param([string]$Name, [string]$Value)
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $Value | npx --yes wrangler secret put $Name 2>&1 | Out-Null
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    if ($code -ne 0) { Die "写入 secret $Name 失败（exit $code）" }
    Ok "secret $Name 已设置"
}

function Get-JsonArray {
    param([string]$Raw)
    $s = $Raw.IndexOf('['); $e = $Raw.LastIndexOf(']')
    if ($s -lt 0 -or $e -le $s) { return @() }
    try { return ($Raw.Substring($s, $e - $s + 1) | ConvertFrom-Json) } catch { return @() }
}

# ---------------------------------------------------------------- 0. 环境检查
Step "0/8 检查本机环境"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "没找到 node，请先安装 Node.js 18+" }
Ok "node $(& node -v)"

# ---------------------------------------------------------------- 1. 登录
Step "1/8 登录 Cloudflare"
$who = Run-Wrangler @("whoami") -AllowFail
if ($who -match "not authenticated") {
    Info "即将打开浏览器，请完成授权后回到本窗口"
    Run-Wrangler @("login") | Out-Null
    $who = Run-Wrangler @("whoami") -AllowFail
}
if ($who -match "not authenticated") { Die "Cloudflare 登录失败，请重跑脚本" }
Ok "已登录 Cloudflare"

# ---------------------------------------------------------------- 2. D1 数据库
Step "2/8 准备 D1 数据库 $DbName"
$dbId = $null
$items = Get-JsonArray (Run-Wrangler @("d1", "list", "--json") -AllowFail)
$hit = $items | Where-Object { $_.name -eq $DbName } | Select-Object -First 1
if ($hit) { $dbId = if ($hit.uuid) { $hit.uuid } else { $hit.id } }
if (-not $dbId) {
    Info "未找到同名数据库，正在创建…"
    $created = Run-Wrangler @("d1", "create", $DbName, "--location", "apac") -AllowFail
    if ($created -match 'database_id\s*=\s*"([0-9a-fA-F-]+)"') {
        $dbId = $Matches[1]
    } else {
        Write-Host $created -ForegroundColor DarkGray
        Die "创建数据库失败，请查看上方输出"
    }
    Ok "数据库已创建"
} else {
    Ok "复用已存在的数据库"
}
Set-DatabaseId $dbId

# ---------------------------------------------------------------- 3. 建表
Step "3/8 初始化数据库表结构"
$run = Run-Wrangler @("d1", "execute", "DB", "--remote", "--file=migrations/0001_init.sql") -AllowFail
if ($script:WranglerExitCode -ne 0) {
    Info "按数据库名重试一次…"
    $run = Run-Wrangler @("d1", "execute", $DbName, "--remote", "--file=migrations/0001_init.sql") -AllowFail
}
if ($script:WranglerExitCode -ne 0) { Write-Host $run -ForegroundColor DarkGray; Die "表结构初始化失败" }
Ok "subscribers / monitor_state 表已就绪（重复执行是安全的，SQL 带 IF NOT EXISTS）"

# ---------------------------------------------------------------- 4. 预部署
Step "4/8 预部署 Worker（创建 Worker 实体，供后续写 secret）"
$pre = Run-Wrangler @("deploy") -AllowFail
if ($script:WranglerExitCode -eq 0) { Ok "Worker 实体已创建" }
else { Warn "预部署输出异常，继续尝试（正式部署仍会执行）" }

# ---------------------------------------------------------------- 5. Secrets
Step "5/8 配置邮件与鉴权 secrets"
$existing = Run-Wrangler @("secret", "list") -AllowFail
$has = @{}
foreach ($name in @("RESEND_API_KEY","SMTP_HOST","SMTP_PORT","SMTP_USERNAME","SMTP_PASSWORD","FROM_EMAIL","SITE_URL","MONITOR_SECRET")) {
    $has[$name] = ($existing -match [regex]::Escape($name))
}

Write-Host "    1) Resend API  —— 推荐，只要一个 API Key，送达率高"
Write-Host "    2) SMTP 邮箱   —— QQ / 163 / 企业邮，需要授权码"
$mailMode = Ask-Value "选择发信方式" "1"

if ($mailMode -eq "1") {
    $resendKey = Ask-Value "Resend API Key（re_ 开头）" -AllowSkip
    if ($resendKey) { Set-Secret "RESEND_API_KEY" $resendKey } elseif ($has["RESEND_API_KEY"]) { Ok "RESEND_API_KEY 已存在，跳过" } else { Die "必须提供 Resend API Key" }
    $fromEmail = Ask-Value "发信地址 FROM_EMAIL（必须是 Resend 已验证域名下的地址）" "status@liyueovo.top"
    Set-Secret "FROM_EMAIL" $fromEmail
}
else {
    $smtpHost = Ask-Value "SMTP 服务器地址（QQ 邮箱 smtp.qq.com / 163 smtp.163.com / 企业邮 smtp.exmail.qq.com）" -AllowSkip
    if ($smtpHost) { Set-Secret "SMTP_HOST" $smtpHost } elseif ($has["SMTP_HOST"]) { Ok "SMTP_HOST 已存在，跳过" } else { Die "必须提供 SMTP_HOST" }

    $smtpPort = Ask-Value "SMTP 端口（回车 = 465）" "465"
    if (-not $smtpPort) { $smtpPort = "465" }
    Set-Secret "SMTP_PORT" $smtpPort

    $smtpUser = Ask-Value "SMTP 用户名（一般是发信地址）" -AllowSkip
    if ($smtpUser) { Set-Secret "SMTP_USERNAME" $smtpUser } elseif ($has["SMTP_USERNAME"]) { Ok "SMTP_USERNAME 已存在，跳过" } else { Die "必须提供 SMTP_USERNAME" }

    $smtpPass = Ask-Value "SMTP 密码 / 授权码" -AllowSkip
    if ($smtpPass) { Set-Secret "SMTP_PASSWORD" $smtpPass } elseif ($has["SMTP_PASSWORD"]) { Ok "SMTP_PASSWORD 已存在，跳过" } else { Die "必须提供 SMTP_PASSWORD" }

    $fromEmail = Ask-Value "发信地址 FROM_EMAIL" -AllowSkip
    if ($fromEmail) { Set-Secret "FROM_EMAIL" $fromEmail } elseif ($has["FROM_EMAIL"]) { Ok "FROM_EMAIL 已存在，跳过" } else { Die "必须提供 FROM_EMAIL" }
}

$siteUrl = Ask-Value "状态页地址 SITE_URL" $DefaultSite
Set-Secret "SITE_URL" $siteUrl

# MONITOR_SECRET 每次重新生成，保证与 GitHub Actions 一致
$monitorSecret = Read-Host "MONITOR_SECRET（直接回车 = 自动生成 48 位随机串）"
if ([string]::IsNullOrWhiteSpace($monitorSecret)) { $monitorSecret = $null } else { $monitorSecret = $monitorSecret.Trim() }
if (-not $monitorSecret) {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $monitorSecret = -join ($bytes | ForEach-Object { $_.ToString("x2") })
}
Set-Secret "MONITOR_SECRET" $monitorSecret

# ---------------------------------------------------------------- 6. 正式部署
Step "6/8 正式部署 Worker"
$deploy = Run-Wrangler @("deploy") -AllowFail
if ($script:WranglerExitCode -ne 0) { Write-Host $deploy -ForegroundColor DarkGray; Die "部署失败，请查看上方输出" }
$urls = [regex]::Matches($deploy, 'https://[a-zA-Z0-9\.-]+\.workers\.dev') | ForEach-Object { $_.Value } | Select-Object -Unique
$workerUrl = $urls | Where-Object { $_ -like "*$WorkerName*" } | Select-Object -First 1
if (-not $workerUrl) { $workerUrl = $urls | Select-Object -First 1 }
if (-not $workerUrl) { Write-Host $deploy -ForegroundColor DarkGray; Die "未解析到 Worker 地址，请查看上方输出" }
Ok "Worker 已上线：$workerUrl"

# ---------------------------------------------------------------- 7. 回填前端
Step "7/8 回填前端订阅接口地址"
$js = Get-Content $AppJsPath -Raw -Encoding UTF8
$newJs = [regex]::Replace($js, 'const SUBSCRIBE_API="[^"]*"', "const SUBSCRIBE_API=`"$workerUrl`"")
if ($newJs -eq $js -and $js -notmatch [regex]::Escape($workerUrl)) { Die "未能定位 assets/app.js 中的 SUBSCRIBE_API" }
[System.IO.File]::WriteAllText($AppJsPath, $newJs, (New-Object System.Text.UTF8Encoding($false)))
Ok "assets/app.js 已指向 $workerUrl"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$html = Get-Content $IndexHtml -Raw -Encoding UTF8
$newHtml = [regex]::Replace($html, 'assets/app\.js\?v=[^"]+', "assets/app.js?v=$stamp")
[System.IO.File]::WriteAllText($IndexHtml, $newHtml, (New-Object System.Text.UTF8Encoding($false)))
Ok "index.html 缓存版本号已刷新为 v=$stamp"

# ---------------------------------------------------------------- 8. 自检
Step "8/8 健康检查"
try {
    $health = Invoke-RestMethod -Uri "$workerUrl/api/health" -TimeoutSec 20
    Ok "Worker 响应正常：$($health | ConvertTo-Json -Compress)"
} catch {
    Warn "健康检查未通过：$($_.Exception.Message)"
}

Write-Host ""
Write-Host "==================== 配置完成 ====================" -ForegroundColor Green
Write-Host "Worker 地址      : $workerUrl"
Write-Host "状态页地址      : $siteUrl"
Write-Host "MONITOR_SECRET  : $monitorSecret"
Write-Host ""
Write-Host "接下来在 GitHub 仓库添加两个 Actions Secret：" -ForegroundColor Cyan
Write-Host "  Settings -> Secrets and variables -> Actions -> New repository secret"
Write-Host "  1) MONITOR_API_URL = $workerUrl"
Write-Host "  2) MONITOR_SECRET = $monitorSecret"
Write-Host ""
Write-Host "然后把改动推送到仓库（assets/app.js、index.html、cloudflare/*）：" -ForegroundColor Cyan
Write-Host "  git add -A ; git commit -m `"feat: enable email subscriptions`" ; git push"
Write-Host ""
Write-Host "自测：状态页 -> 点『订阅更新』-> 填邮箱 -> 去邮箱点确认链接 ->" -ForegroundColor Cyan
Write-Host "再到 Actions 里手动跑一次 `Website monitoring` 验证推送链路。" -ForegroundColor Cyan
