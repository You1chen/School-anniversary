<#
  暨南大学校史问答库 · 校验与审阅稿生成
  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File "知识库\校验并生成审阅稿.ps1"
    powershell -NoProfile -ExecutionPolicy Bypass -File "知识库\校验并生成审阅稿.ps1" -SyncManifest

  默认行为：只做校验 + 重新生成 审阅稿.md，**不修改任何数据**。
  加 -SyncManifest：额外把各分片实际条目数写回 manifest.json（改完数据后跑一次即可）。
#>
param([switch]$SyncManifest)

$ErrorActionPreference = 'Stop'
$kb = Split-Path -Parent $MyInvocation.MyCommand.Path
$shardsDir = Join-Path $kb 'shards'
$manifestPath = Join-Path $kb 'manifest.json'

if (-not (Test-Path -LiteralPath $shardsDir)) { throw "找不到分片目录：$shardsDir" }

# ---------- 读取分片 ----------
$shards = @()
$all = @()
$problems = New-Object System.Collections.Generic.List[string]

foreach ($f in (Get-ChildItem -LiteralPath $shardsDir -File -Filter *.json | Sort-Object Name)) {
  $j = $null
  try { $j = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { $problems.Add("JSON 解析失败：$($f.Name) —— $($_.Exception.Message)"); continue }

  if (-not $j.shard)  { $problems.Add("缺 shard 字段：$($f.Name)") }
  if (-not $j.items)  { $problems.Add("缺 items 数组：$($f.Name)"); continue }

  # 文件名与 shard 码一致性
  if ($j.shard -and $f.Name -notlike "$($j.shard)-*") { $problems.Add("文件名与 shard 码不一致：$($f.Name) / shard=$($j.shard)") }

  $shards += [pscustomobject]@{ Code=$j.shard; Title=$j.title; File=$f.Name; Count=$j.items.Count }
  foreach ($it in $j.items) {
    if (-not $it.id -or -not $it.question -or -not $it.answer -or -not $it.source) {
      $problems.Add("缺必填字段（id/question/answer/source）：$($f.Name) / $($it.id)")
    }
    if ($it.status -and $it.status -ne 'verified' -and -not $it.caveat) {
      $problems.Add("status=$($it.status) 但没有 caveat：$($it.id)")
    }
    $all += [pscustomobject]@{ Shard=$j.shard; Item=$it }
  }
}

# ---------- 校验 ----------
$dupId = $all | Group-Object { $_.Item.id } | Where-Object { $_.Count -gt 1 }
if ($dupId) { $problems.Add("重复 ID：" + (($dupId | ForEach-Object { $_.Name }) -join ', ')) }

$seen = @{}
foreach ($row in $all) {
  $it = $row.Item
  foreach ($q in (@($it.question) + @($it.aliases))) {
    if ([string]::IsNullOrWhiteSpace($q)) { continue }
    $k = $q.Trim()
    if ($seen.ContainsKey($k)) { $problems.Add("问法被多条记录占用：「$k」 $($seen[$k]) ↔ $($it.id)") }
    else { $seen[$k] = $it.id }
  }
}

# 与 manifest 的计数比对
$manifest = $null
if (Test-Path -LiteralPath $manifestPath) {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($ms in $manifest.shards) {
    $real = $shards | Where-Object { $_.Code -eq $ms.shard }
    if (-not $real) { $problems.Add("manifest 登记了分片 $($ms.shard)，但 shards 目录下没有对应文件") ; continue }
    if ($real.Count -ne $ms.count) { $problems.Add("计数不符：$($ms.shard) manifest=$($ms.count) 实际=$($real.Count)") }
  }
  foreach ($s in $shards) {
    if (-not ($manifest.shards | Where-Object { $_.shard -eq $s.Code })) {
      $problems.Add("分片 $($s.Code) 已存在但未登记进 manifest.shards")
    }
  }
}

# ---------- 输出校验结果 ----------
$totalQ = $seen.Count
Write-Host "分片：$($shards.Count) 个｜条目：$($all.Count) 条｜覆盖问法：$totalQ 种"
$all | Group-Object { $_.Item.status } | Sort-Object Name | ForEach-Object { Write-Host ("  status={0}: {1}" -f $_.Name, $_.Count) }
if ($problems.Count -eq 0) {
  Write-Host "校验通过：无结构问题、无重复 ID、无问法冲突、计数一致。" -ForegroundColor Green
} else {
  Write-Host "发现 $($problems.Count) 个问题：" -ForegroundColor Yellow
  $problems | ForEach-Object { Write-Host "  - $_" }
}

# ---------- 同步 manifest 计数 ----------
if ($SyncManifest) {
  if (-not $manifest) { throw "找不到 manifest.json，无法同步计数" }
  foreach ($ms in $manifest.shards) {
    $real = $shards | Where-Object { $_.Code -eq $ms.shard }
    if ($real) { $ms.count = $real.Count }
  }
  $manifest.updated = (Get-Date -Format 'yyyy-MM-dd')
  [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "已把各分片条目数写回 manifest.json"
}

# ---------- 生成审阅稿 ----------
$out = New-Object System.Collections.Generic.List[string]
$out.Add("# 校史问答库 · 审阅稿")
$out.Add("")
$out.Add("> 本文件由 ``校验并生成审阅稿.ps1`` 依据 ``shards/*.json`` **自动生成**，请勿直接编辑本文件——改数据请改分片 JSON。")
$out.Add("> 生成时间：$(Get-Date -Format 'yyyy-MM-dd')｜分片 $($shards.Count) 个｜条目 $($all.Count) 条｜覆盖问法 $totalQ 种")
$out.Add("> 用途：确认问法粒度、答案长度、出处与标注。")
$out.Add("")
$out.Add("## 总览")
$out.Add("")
$out.Add("| 分片码 | 名称 | 条目 | 文件 |")
$out.Add("|---|---|---|---|")
foreach ($s in ($shards | Sort-Object Code)) { $out.Add("| $($s.Code) | $($s.Title) | $($s.Count) | ``$($s.File)`` |") }
$out.Add("")
foreach ($s in ($shards | Sort-Object Code)) {
  $items = $all | Where-Object { $_.Shard -eq $s.Code } | ForEach-Object { $_.Item }
  $out.Add("---")
  $out.Add("")
  $out.Add("## $($s.Code) · $($s.Title)（$($items.Count) 条）")
  $out.Add("")
  foreach ($i in $items) {
    $cjk = ([regex]::Matches($i.answer, '[\u4e00-\u9fff]')).Count
    $out.Add("### ``$($i.id)`` $($i.question)")
    if ($i.aliases) { $out.Add("- **同义问法**：" + (@($i.aliases) -join "｜")) }
    $out.Add("- **答案**（$cjk 字）：$($i.answer)")
    $out.Add("- **出处**：$($i.source)")
    $meta = @()
    if ($i.status) { $meta += "status=$($i.status)" }
    if ($i.period) { $meta += "period=$($i.period)" }
    if ($i.type)   { $meta += "type=$($i.type)" }
    if ($i.keywords) { $meta += "keywords=" + (@($i.keywords) -join '/') }
    if ($meta.Count) { $out.Add("- **标注**：" + ($meta -join "｜")) }
    if ($i.caveat) { $out.Add("- ⚠ **注意**：$($i.caveat)") }
    $out.Add("")
  }
}
$reviewPath = Join-Path $kb '审阅稿.md'
[System.IO.File]::WriteAllLines($reviewPath, $out, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "审阅稿已生成：$reviewPath"
