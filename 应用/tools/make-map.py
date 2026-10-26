# -*- coding: utf-8 -*-
"""把 原图/校园地图.jpg（6458×8901）等比缩到宽 2400，存成 应用/map/campus-map.jpg。

用法: python -I 应用/tools/make-map.py 原图/校园地图.jpg 应用/map/campus-map.jpg

参数是**倒着试出来的**，不许顺手改：把 optimize × progressive × subsampling × 几档质量
全扫一遍，唯一能重现现有那个文件（963258 B，sha256 d7591c4f…）的就是这一组
——宽 2400、LANCZOS、q70、subsampling=2（4:2:0）。build.mjs 的注释里只写了
「宽 2400px、JPEG q70」，少了 subsampling 这一项，照那句话重做对不上。

必须**等比**缩：热区坐标用的是源图像素坐标系（template.html 的 SVG viewBox="0 0 6458 8901"），
改了宽高比，12 个热区就整体错位。build.mjs 里有闸门校宽高比，它在打包时才会响。

不属于交付链：build.mjs 从不运行本脚本，它只读产物。换过原图之后手动跑，然后重跑
node 应用/build.mjs，否则交付件里还是旧图。
"""
import sys

from PIL import Image

# 路径里有中文，而 Windows 的控制台/管道默认按 GBK 编码输出，日志会变成乱码
sys.stdout.reconfigure(encoding='utf-8')

SRC, DST = sys.argv[1], sys.argv[2]
WIDTH = 2400
QUALITY = 70
SUBSAMPLING = 2   # 4:2:0 —— 少了这一项就重现不出现有文件

img = Image.open(SRC).convert('RGB')
print('src %dx%d [%s]' % (img.width, img.height, SRC))
h = round(img.height * WIDTH / img.width)
small = img.resize((WIDTH, h), Image.LANCZOS)
small.save(DST, 'JPEG', quality=QUALITY, optimize=True, progressive=True, subsampling=SUBSAMPLING)
print('out %dx%d  LANCZOS  JPEG q%d subsampling=%d  [%s]' % (
    small.width, small.height, QUALITY, SUBSAMPLING, DST))
