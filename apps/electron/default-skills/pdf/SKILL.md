---
name: pdf
description: 当任务涉及任何 PDF 输入或输出时使用，包括读取、搜索、摘要、问答、文本或图片提取，以及创建、合并、拆分、旋转、选页、水印、元数据、加密、解密、OCR 和表单相关处理。只读任务优先使用 Domi 内置 Read；扫描件或无有效文本层的 PDF 进入显式 OCR 分支。
version: "2.0.0"
license: AGPL-3.0-only
---

# PDF 处理

以“只读优先、原件不变、输出可验证”为原则处理 PDF。

## 不可违反的规则

1. 只读任务先使用 Domi 内置 Read，不为简单摘要安装依赖或写脚本。
2. PDF 超过 100 页时先看页数、目录和关键词，再分段读取，避免一次把全文塞入上下文。
3. 修改前保留原件，输出必须是新路径。
4. 依赖只安装到会话临时 venv；禁止全局安装或污染用户项目。
5. 查询、下载、OCR 云服务和字体获取都不得静默联网。
6. 输出后重新打开，检查页数、顺序、元数据、加密状态和关键页面。
7. 修改已签名 PDF 通常会使签名失效，必须提前说明。

## 路由

- **阅读/摘要/问答**：Read → 定位页码 → 回答并引用页码。
- **长 PDF**：先抽取目录或分段搜索，只读取命中邻域。
- **扫描件**：确认没有可用文本层后进入 OCR；不要把空提取结果当作空白文件。
- **合并/拆分/旋转/加密**：使用 `pypdf`。
- **从零创建或生成水印页**：使用 `reportlab`，再按需与 `pypdf` 组合。
- **表单/XFA/图层/附件/数字签名**：先说明保真风险，必要时只读交付。

## 临时环境

```bash
python -m pip index versions pypdf
python -m pip index versions reportlab
python -m venv "<session-temp>/pdf-work/venv"
"<session-temp>/pdf-work/venv/Scripts/python.exe" -m pip install \
  "pypdf==<verified-version>" "reportlab==<verified-version>"
```

POSIX 使用 `venv/bin/python`。记录精确版本、来源、许可证和用途。2026-08-29 参考基线：`pypdf 6.16.2`（BSD 3-Clause）、`reportlab 5.0.1`（BSD）；实际执行时重新查询。

## 检查 PDF

```python
from pathlib import Path
from pypdf import PdfReader

source = Path("input.pdf")
reader = PdfReader(source)
print("pages", len(reader.pages))
print("encrypted", reader.is_encrypted)
print("metadata", dict(reader.metadata or {}))
for index, page in enumerate(reader.pages[:3], start=1):
    print(index, (page.extract_text() or "")[:500])
```

加密文件需要密码时不得猜测或绕过；向用户索取合法密码。

## 合并与拆分

```python
from pathlib import Path
from pypdf import PdfReader, PdfWriter

inputs = [Path("part-a.pdf"), Path("part-b.pdf")]
output = Path("output/combined.pdf")
if output.exists():
    raise FileExistsError(output)

writer = PdfWriter()
for source in inputs:
    reader = PdfReader(source)
    for page in reader.pages:
        writer.add_page(page)

output.parent.mkdir(parents=True, exist_ok=True)
with output.open("wb") as stream:
    writer.write(stream)
```

拆分指定页段：

```python
from pathlib import Path
from pypdf import PdfReader, PdfWriter

source = Path("input.pdf")
output = Path("output/pages-3-7.pdf")
reader = PdfReader(source)
writer = PdfWriter()
for page in reader.pages[2:7]:  # 用户页码 3-7；Python 下标从 0 开始
    writer.add_page(page)
with output.open("wb") as stream:
    writer.write(stream)
```

始终把用户可见页码转换成零基下标后再次核对，避免 off-by-one。

## 旋转、元数据和加密

```python
from pathlib import Path
from pypdf import PdfReader, PdfWriter

source = Path("input.pdf")
output = Path("output/input-processed.pdf")
reader = PdfReader(source)
writer = PdfWriter()

for index, page in enumerate(reader.pages):
    if index == 0:
        page.rotate(90)
    writer.add_page(page)
writer.add_metadata({"/Title": "处理后的文档"})
# 如用户明确要求加密：writer.encrypt("<user-password>")

with output.open("wb") as stream:
    writer.write(stream)
```

不要把密码写入源码、日志、命令历史或交付说明。

## 创建 PDF

```python
from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

output = Path("output/summary.pdf")
output.parent.mkdir(parents=True, exist_ok=True)
if output.exists():
    raise FileExistsError(output)

pdf = canvas.Canvas(str(output), pagesize=A4)
pdf.setTitle("项目摘要")
pdf.drawString(72, 780, "项目摘要")
pdf.drawString(72, 750, "此文件由经过验证的本地流程生成。")
pdf.save()
```

包含中文时必须使用用户有权使用且本机可用的字体，并检查字体嵌入和渲染；不要假设默认 Helvetica 支持中文。

## 水印

先用 `reportlab` 创建与目标页面尺寸匹配的单页水印，再用 `pypdf` 的 `merge_page()` 合并到每个输出页。不同页面尺寸应分别生成水印；不要固定 A4 后套用到所有页面。

## OCR

1. 先抽查多页的 `extract_text()`，确认文本层确实缺失或不可用。
2. 询问 OCR 语言、页范围和准确率要求。
3. 优先使用本机已有的 OCR 工具；不要自动安装大型系统组件。
4. 云 OCR 只有在用户明确授权数据外发时才能使用。
5. OCR 后保留原 PDF，并随机抽查数字、日期、专有名词和表格。

## 验证

```python
from pathlib import Path
from pypdf import PdfReader

output = Path("output/combined.pdf")
reader = PdfReader(output)
assert output.stat().st_size > 0
assert len(reader.pages) > 0
print({"pages": len(reader.pages), "encrypted": reader.is_encrypted})
```

按任务补充：

- 合并页数等于输入页数之和且顺序正确；
- 拆分页段与首尾内容正确；
- 旋转只影响目标页；
- 元数据重新读取一致；
- 加密文件无密码不可读，正确密码可读；
- 抽查首页、中间页和末页的视觉结果。

无法视觉渲染时明确写“已完成结构验证，未完成视觉渲染验证”。

## 保真边界

重写可能影响数字签名、XFA、AcroForm 行为、书签、图层、附件、增量更新、注释、颜色配置和字体。发现这些特性时先报告，不得声称普通页级操作可以完全无损保留。

## 交付说明

报告输入/输出路径、操作、页数变化、依赖版本与许可证、OCR 状态、结构和视觉验证结果、密码处理方式以及未验证的专有特性。始终保留原文件。
