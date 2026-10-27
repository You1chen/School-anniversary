# 启动本地 Spark-X2.5-1.7B 服务（llama.cpp / CPU）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File "应用\tools\start-spark.ps1"
#   powershell ... -File "应用\tools\start-spark.ps1" -Port 8080 -Ctx 8192 -Threads 12
#
# 启动后：页面 →「设置」→「本地模型」→ 扫描可用模型 → 选一个
# （本地模型走的是 OpenAI 兼容接口，不需要改任何代码）

param(
  [int]$Port = 8080,
  [int]$Ctx = 8192,
  [int]$Threads = 12,
  [string]$Bin = 'D:\spark-local\bin\llama-server.exe',
  [string]$Model = 'D:\spark-local\models\Spark-X2.5-1.7B-Q4_K_M.gguf'
)

$ErrorActionPreference = 'Stop'
$BIN = $Bin

if (-not (Test-Path $BIN)) { Write-Host "找不到 llama-server：$BIN" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $Model)) { Write-Host "找不到模型：$Model" -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '启动本地模型服务' -ForegroundColor Cyan
Write-Host "  可执行: $BIN"
Write-Host "  模型  : $((Get-Item $Model).Length / 1MB -as [int]) MB  $Model"
Write-Host "  地址  : http://127.0.0.1:$Port"
Write-Host "  上下文: $Ctx｜线程: $Threads"
Write-Host ''
Write-Host '说明：' -ForegroundColor Yellow
Write-Host '  · 该服务默认允许所有来源跨域，所以 file:// 打开的页面可以直接调用'
Write-Host '  · 页面调用时会自动带 enable_thinking=false 与 JSON 语法约束（仅本地线路）'
Write-Host '  · CPU 推理约 14 秒/问，属正常；按 Ctrl+C 停止'
Write-Host ''

& $BIN -m $Model --host 127.0.0.1 --port $Port -c $Ctx -t $Threads --jinja
