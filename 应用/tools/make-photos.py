# -*- coding: utf-8 -*-
"""把校园地图各区域要配的历史照片缩到长边 560px，存成 应用/photos/<MP 编号>.jpg。

用法: python -I 应用/tools/make-photos.py 暨大史料 应用/photos 应用/tools/photos-src.json

photos-src.json 是这 11 张照片的**逐张来源表**：每条的 key 是 MP 编号（与知识库分片
MP-校园导览.json、底图热区、文件名主干四处同构），src 是相对 暨大史料/ 的文件路径。
它同时就是"哪张史照来自哪份史料"的唯一记录——知识库里的 source 只记到图注号（如 A14-01），
落到第几个文件得靠这张表。

不属于交付链：build.mjs 从不运行本脚本，它只读产物。改过史料库之后手动跑，然后重跑
node 应用/build.mjs，否则交付件里还是旧图。

用 PIL 不是随便挑的：应用/photos/ 里现在这些字节就是 PIL（本机 Python 3.9.9 / Pillow 11.3.0）
编出来的，换成别的库重编对不上原文件，就没法用逐字节比对来验证参数抄对了没有。
"""
import json
import os
import sys

from PIL import Image

STORY_ROOT, OUT_DIR, JOBS = sys.argv[1], sys.argv[2], sys.argv[3]
LONG_EDGE = 560
QUALITY = 70

os.makedirs(OUT_DIR, exist_ok=True)
jobs = json.load(open(JOBS, encoding='utf-8'))

total = 0
missing = []
for j in jobs:
    src = os.path.join(STORY_ROOT, j['src'])
    if not os.path.exists(src):
        print('MISSING\t%s\t%s' % (j['key'], j['src']))
        missing.append(j['key'])
        continue
    im = Image.open(src).convert('RGB')
    w, h = im.size
    scale = LONG_EDGE / float(max(w, h))
    if scale < 1:
        im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    dst = os.path.join(OUT_DIR, j['key'] + '.jpg')
    im.save(dst, 'JPEG', quality=QUALITY, optimize=True, progressive=True)
    size = os.path.getsize(dst)
    total += size
    print('%s\t%dx%d -> %dx%d\t%d B' % (j['key'], w, h, im.size[0], im.size[1], size))

print('TOTAL\t%d files\t%d B\t%.0f KB' % (len(jobs), total, total / 1024.0))
if missing:
    # 缺一张就少一个地标的配图，而 build.mjs 的闸门只在"知识库有、photos 里没有"时拦得下来；
    # 这里直接退非零，免得把少了一张当成跑成功。
    sys.exit('有 %d 张源图没找到：%s' % (len(missing), ', '.join(missing)))
