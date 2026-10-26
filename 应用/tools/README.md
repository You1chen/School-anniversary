# 应用\tools\ —— 派生图的预处理脚本

页面吃的图没有一张是原图：11 张史照、底图、校徽、立绘、鲸尾共 4.4 MB 的派生图，全是离线缩出来的，
构建时内联进单文件 HTML。这里放的就是缩它们的那几个脚本——**离线跑、不在构建链上**
（`build.mjs` 从不读 `tools\`，它只读产物）。

所以顺序永远是：**改原图 → 跑这里的脚本 → 再跑 `node 应用/build.mjs`**。少最后一步，交付件里还是旧图。

## 总表

| 派生图 | 源图 | 参数 | 脚本 | 逐字节复现 |
|---|---|---|---|---|
| `应用\avatar\a-jing.jpg`（340×604，48.9 KB） | `原图\角色立绘.png` | 按宽缩到 340（高随比例得 604），JPEG q88，双三次 | `make-assets.mjs avatar` | ✅ 50032 B，sha256 `e5a15b94…` |
| `应用\avatar\whale-tail.png`（64×93，6.9 KB） | `原图\角色设定表.png` | 裁 `1348,298 178×258` → 宽 64，底色刷纯白（与角点色差 ≤10），PNG | `make-assets.mjs tail` | ✅ 7102 B，sha256 `76179a8e…` |
| `应用\map\campus-map.jpg`（2400×3308，941 KB） | `原图\校园地图.jpg` | 等比缩到宽 2400，JPEG q70，**subsampling=2**，LANCZOS | `make-map.py` | ✅ 963258 B，sha256 `d7591c4f…` |
| `应用\photos\MP-00*.jpg`（11 张，346 KB） | `暨大史料\…`（逐张见 `photos-src.json`） | 长边 560，JPEG q70，optimize+progressive，LANCZOS | `make-photos.py` | ✅ 11/11 张相同 |
| `应用\logo.jpg`（192×192，16.9 KB） | `暨大史料\专题-校徽校门校训校歌\A28-06-现在的暨南大学校徽.jpg` | 缩到 192×192，JPEG q92 | `make-assets.mjs logo` | ❌ **复现不出来，见下** |

「逐字节复现」是拿脚本重跑一遍、跟交付件里正在用的那个文件 `cmp` 的结果，不是"看着一样"。

## 校徽那一处的如实说明

`应用\logo.jpg` 比这套脚本早两天，是另一个工具编的，**原始编码参数没有留下来**。为了找回它，
两轮搜索都跑完了，没有一种能对上：

- PIL：6 种重采样 × q88–96 × optimize/progressive/subsampling 全组合；
- .NET `System.Drawing`：4 种插值 × {HighQuality, Half, None} × {32bppArgb, 24bppRgb} × q86–96，共 528 种。

最接近的一组差 34 字节（17361 B vs 现有的 17327 B）——差得不多，但**不同就是不同**，所以这里
不写"一致"。`make-assets.mjs logo` 是**重制**：尺寸一样、目视等价，但产物字节会变（约 17.4 KB），
交付件也会跟着变，得重跑构建并目视确认。正因为如此，它**不进默认流程**——手一抖跑个 `all`，
校徽就被悄悄换掉了，而构建照过、页面也看不出来。

## 为什么要两种运行时（.mjs 与 .py 混着放）

因为只有跟当年那个编码器一致，重跑出来的字节才能跟现有文件一模一样。史照和底图的字节是
**PIL**（本机 Python 3.9.9 / Pillow 11.3.0）编出来的，立绘与鲸尾是 **.NET System.Drawing** 编的
（经 PowerShell `-EncodedCommand` 调用；本机执行策略是 Restricted，不用 `-ExecutionPolicy Bypass`）。
把 `make-photos.py` 改写成 .NET 也能出图，但就再也证明不了"参数抄对了没有"。
这是为了可复现，不是没收干净。

## 用法

```powershell
# 派生图（改过 原图/ 或 暨大史料/ 之后）
node 应用\tools\make-assets.mjs          # 立绘 + 鲸尾（默认；这两张能逐字节复现）
node 应用\tools\make-assets.mjs logo     # 校徽：单独点名才跑，且是重制不是复现
python -I 应用\tools\make-map.py "原图\校园地图.jpg" "应用\map\campus-map.jpg"
python -I 应用\tools\make-photos.py 暨大史料 应用\photos 应用\tools\photos-src.json
node 应用\build.mjs                      # 改完必须重跑，否则交付件里还是旧图

# 交付前的两件事
node 应用\tools\gate-test.mjs            # 反向测试 build.mjs 的闸门（13 个用例：弄坏→看是否真中止→恢复）
node 应用\tools\shot.mjs map             # 用 Edge 无头截图，补 README 里「须在浏览器里逐条目视」那一步
```

`make-assets.mjs` 每次会把生成的那段 PowerShell 原文落到临时目录（`%TEMP%\jnu-tools\*.ps`）——
PowerShell 报错时甩出来的 CLIXML 连行号都对不上模板行号，照着落盘那份看才找得到是哪个字符。

## 两个不是预处理脚本的

- `gate-test.mjs`——**反向测试** `build.mjs` 的闸门。闸门最容易的失效方式不是没写，而是写了却永远不触发
  （正则匹配不上、拦错了对象）；正向跑一遍全绿证明不了这个，只有真弄坏一次才知道。它会临时改写
  `知识库\persona.json`、`应用\template.html` 与两张头像，跑完一律恢复，恢复后还要能正常构建才算过。
- `shot.mjs`——把交付件复制到临时目录、注入一小段脚本驱动它（比如替你点开某个地标）再截图。
  截图落在 `%TEMP%\jnu-shots\`，**交付件本身一个字节都不动**。有些问题只有像素能回答：12 处色块在底图上
  盖得准不准、浮层文字有没有压住图上印的地名。

## 记一笔：photos-src.json 是什么

它是这 11 张史照的**逐张来源表**：每条的 `key` 是 MP 编号（与知识库分片、底图热区、文件名主干
四处同构），`src` 是相对 `暨大史料\` 的路径。知识库里的 `source` 只记到图注号（如 `A14-01`），
落到第几个**文件**得靠这张表——它是"哪张史照来自哪份史料"的唯一记录，所以别把它当普通的参数文件删了。
