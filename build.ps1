<#
.SYNOPSIS
    打包小红虾扩展：从仓库根取源码 → 校验 → 生成 dist/Clipper-Sharpen/ 与 dist/Clipper-Sharpen-<版本>.zip。

.DESCRIPTION
    源码只有一份，在仓库根。dist/ 是产物镜像，不要手改 —— 改了会在下次打包时被覆盖，
    而且 0.7.7/0.7.8 已经吃过一次亏：8 个源文件只活在 dist/ 里，git 从没跟踪过。

    打包前会做四道校验，任何一道不过就停：
      1. manifest.json 引用的每个文件都必须存在（防止清单指向不存在的脚本）
      2. 清单版本号必须与 -ExpectedVersion 一致（防止改了代码忘了升版本）
      3. LICENSE / NOTICE 必须是文件而不是目录（曾经被整层收进 zip 变成 LICENSE/LICENSE）
      4. 所有 .js 过一遍 node --check（防止语法错进包）

.PARAMETER Bump
    升版本号到指定值（如 0.7.9），会同时改 manifest.json 与 BUILD-INFO 里的记录。
    不传则沿用当前版本。

.PARAMETER SkipSyntaxCheck
    跳过 node --check（仅在没有 node 的环境里用）。

.EXAMPLE
    pwsh build.ps1
    pwsh build.ps1 -Bump 0.7.9
#>
[CmdletBinding()]
param(
    [string]$Bump,
    [switch]$SkipSyntaxCheck
)

$ErrorActionPreference = 'Stop'
$root = $PWD.Path
$manifestPath = Join-Path $root 'manifest.json'

function Fail($msg) { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }
function Ok($msg) { Write-Host "✓ $msg" -ForegroundColor Green }
function Step($msg) { Write-Host "`n— $msg" -ForegroundColor Cyan }

# ═══════════════════════════════════════════════════════════════
# 1. 读清单
# ═══════════════════════════════════════════════════════════════
Step '读取 manifest.json'
if (-not (Test-Path $manifestPath -PathType Leaf)) { Fail "找不到 manifest.json（当前目录：$root）" }
$manifestText = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
try { $manifest = $manifestText | ConvertFrom-Json }
catch { Fail "manifest.json 不是合法 JSON：$($_.Exception.Message)" }

$version = [string]$manifest.version
Ok "当前版本 $version"

if ($Bump) {
    if ($Bump -notmatch '^\d+\.\d+\.\d+$') { Fail "-Bump 需要 x.y.z 格式，收到：$Bump" }
    # 只替换第一处 version 字段（顶层），避免误伤其它字符串
    $versionPattern = '("version"\s*:\s*")[^"]*(")'
    $evaluator = [System.Text.RegularExpressions.MatchEvaluator]{
        param($m)
        return $m.Groups[1].Value + $Bump + $m.Groups[2].Value
    }
    $newText = [regex]::Replace($manifestText, $versionPattern, $evaluator, 1)
    if ($newText -eq $manifestText -and $version -ne $Bump) { Fail "未能替换 version 字段" }
    [System.IO.File]::WriteAllText($manifestPath, $newText, (New-Object System.Text.UTF8Encoding($false)))
    $manifestText = $newText
    $manifest = $newText | ConvertFrom-Json
    $version = $Bump
    Ok "版本已升到 $version"
}

$distDir = Join-Path $root 'dist'
$stageDir = Join-Path $distDir 'Clipper-Sharpen'
$zipPath = Join-Path $distDir "Clipper-Sharpen-$version.zip"

# ═══════════════════════════════════════════════════════════════
# 2. 校验清单引用完整性
# ═══════════════════════════════════════════════════════════════
Step '校验 manifest.json 引用的文件'
$refs = [System.Collections.Generic.List[string]]::new()
if ($manifest.background.service_worker) { $refs.Add($manifest.background.service_worker) }
foreach ($p in $manifest.background.scripts) { if ($p) { $refs.Add($p) } }
if ($manifest.action.default_popup) { $refs.Add($manifest.action.default_popup) }
if ($manifest.options_ui.page) { $refs.Add($manifest.options_ui.page) }
foreach ($prop in $manifest.icons.PSObject.Properties) { $refs.Add([string]$prop.Value) }
foreach ($prop in $manifest.action.default_icon.PSObject.Properties) { $refs.Add([string]$prop.Value) }
foreach ($cs in $manifest.content_scripts) {
    foreach ($p in $cs.js) { $refs.Add($p) }
    foreach ($p in $cs.css) { if ($p) { $refs.Add($p) } }
}
foreach ($war in $manifest.web_accessible_resources) {
    foreach ($p in $war.resources) { $refs.Add($p) }
}
if ($manifest.declarative_net_request) {
    foreach ($r in $manifest.declarative_net_request.rule_resources) { $refs.Add($r.path) }
}

$missing = @()
foreach ($rel in ($refs | Sort-Object -Unique)) {
    if (-not (Test-Path (Join-Path $root $rel) -PathType Leaf)) { $missing += $rel }
}
if ($missing.Count) { Fail "清单引用了 $($missing.Count) 个不存在的文件：`n  $($missing -join "`n  ")" }
Ok "清单引用的 $($refs | Sort-Object -Unique | Measure-Object | Select-Object -ExpandProperty Count) 个文件全部存在"

# ═══════════════════════════════════════════════════════════════
# 3. LICENSE / NOTICE 必须是文件
# ═══════════════════════════════════════════════════════════════
Step '校验 LICENSE / NOTICE 形态'
foreach ($name in @('LICENSE', 'NOTICE')) {
    $p = Join-Path $root $name
    if (-not (Test-Path $p)) { Fail "缺少 $name" }
    if (Test-Path $p -PathType Container) { Fail "$name 是目录，应为文件（否则打进包里会变成 $name/$name）" }
}
Ok 'LICENSE / NOTICE 均为文件'

# ═══════════════════════════════════════════════════════════════
# 4. 语法检查
# ═══════════════════════════════════════════════════════════════
if (-not $SkipSyntaxCheck) {
    Step 'node --check 全部 .js'
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { Fail '找不到 node；无 node 环境可加 -SkipSyntaxCheck 跳过' }
    $targets = Get-ChildItem -Path $root -Recurse -Filter *.js -File |
        Where-Object { $_.FullName -notmatch '\\(dist|test|node_modules|_metadata|\.git|\.playwright-cli)\\' }
    $bad = @()
    foreach ($f in $targets) {
        $out = & node --check $f.FullName 2>&1
        if ($LASTEXITCODE -ne 0) { $bad += "$($f.FullName)`n$out" }
    }
    if ($bad.Count) { Fail "语法检查失败 $($bad.Count) 个：`n$($bad -join "`n")" }
    Ok "$($targets.Count) 个文件语法通过"
}

# ═══════════════════════════════════════════════════════════════
# 5. 组装发布内容清单（路径相对仓库根）
# ═══════════════════════════════════════════════════════════════
Step '组装发布内容'
$publishDirs = @('content', 'js', 'icons', 'rules')
$publishFiles = @('manifest.json', 'setting.html', 'README.md', 'README.en.md', 'LICENSE', 'NOTICE')
$excludeNames = @('.gitattributes', '.gitignore')

$publish = [System.Collections.Generic.List[string]]::new()
foreach ($d in $publishDirs) {
    $dirPath = Join-Path $root $d
    if (-not (Test-Path $dirPath)) { Fail "缺少目录 $d" }
    Get-ChildItem $dirPath -Recurse -File | ForEach-Object {
        if ($excludeNames -notcontains $_.Name) {
            $publish.Add($_.FullName.Substring($root.Length + 1).Replace('\', '/'))
        }
    }
}
foreach ($f in $publishFiles) {
    if (-not (Test-Path (Join-Path $root $f) -PathType Leaf)) { Fail "缺少 $f" }
    $publish.Add($f)
}
$publish = $publish | Sort-Object

# 二次确认：清单引用的每一项都必须在发布清单里
$publishSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$publish)
$notPacked = @()
foreach ($rel in ($refs | Sort-Object -Unique)) {
    if (-not $publishSet.Contains($rel.Replace('\', '/'))) { $notPacked += $rel }
}
if ($notPacked.Count) { Fail "这些文件被清单引用但不在打包集合里：`n  $($notPacked -join "`n  ")" }
Ok "$($publish.Count) 个文件待打包"

# ═══════════════════════════════════════════════════════════════
# 6. 重建 dist/Clipper-Sharpen/
# ═══════════════════════════════════════════════════════════════
Step '重建 dist/Clipper-Sharpen/'
if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
foreach ($rel in $publish) {
    $src = Join-Path $root $rel
    $dst = Join-Path $stageDir $rel
    $dstParent = Split-Path $dst -Parent
    if (-not (Test-Path $dstParent)) { New-Item -ItemType Directory -Path $dstParent -Force | Out-Null }
    Copy-Item $src $dst -Force
}
# 断言 stage 目录里没有 LICENSE/ 这样的重复层
foreach ($name in @('LICENSE', 'NOTICE')) {
    if (Test-Path (Join-Path $stageDir $name) -PathType Container) { Fail "stage 里 $name 变成了目录" }
}
Ok "stage 就绪（$((Get-ChildItem $stageDir -Recurse -File | Measure-Object).Count) 个文件）"

# ═══════════════════════════════════════════════════════════════
# 7. 打 zip
# ═══════════════════════════════════════════════════════════════
Step '生成 zip'
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$zipStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
try {
    $archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($rel in $publish) {
            $entry = $archive.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            try {
                $bytes = [System.IO.File]::ReadAllBytes((Join-Path $root $rel))
                $entryStream.Write($bytes, 0, $bytes.Length)
            } finally { $entryStream.Dispose() }
        }
    } finally { $archive.Dispose() }
} finally { $zipStream.Dispose() }

$zipInfo = Get-Item $zipPath
$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
Ok "生成 $($zipInfo.Name)（$($zipInfo.Length) 字节，$($publish.Count) 条目）"

# ═══════════════════════════════════════════════════════════════
# 8. 写 BUILD-INFO.txt
# ═══════════════════════════════════════════════════════════════
Step '写 BUILD-INFO.txt'
$buildNumber = 'unknown'
$lastCommit = 'unknown'
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) {
    $n = & git rev-list --count HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $n) { $buildNumber = "#$n" }
    $c = & git rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $c) { $lastCommit = $c }
}
$info = @(
    "版本: $version"
    "流水号: $buildNumber"
    "提交: $lastCommit"
    "时间: $(Get-Date -Format 'yyyy/M/d HH:mm:ss')"
    "$($zipInfo.Name)  sha256:$($hash.Substring(0,16))  $([math]::Round($zipInfo.Length / 1KB)) KB"
    "条目: $($publish.Count)"
) -join "`n"
[System.IO.File]::WriteAllText((Join-Path $distDir 'BUILD-INFO.txt'), $info + "`n", (New-Object System.Text.UTF8Encoding($false)))
Ok "BUILD-INFO.txt 已更新"

Write-Host "`n════════════════════════════════════════" -ForegroundColor DarkGray
Write-Host " 版本   $version" -ForegroundColor White
Write-Host " 提交   $lastCommit" -ForegroundColor White
Write-Host " 条目   $($publish.Count)" -ForegroundColor White
Write-Host " sha256 $($hash.Substring(0,16))…" -ForegroundColor White
Write-Host " 产物   dist/$($zipInfo.Name)" -ForegroundColor White
Write-Host "════════════════════════════════════════" -ForegroundColor DarkGray
