---
name: pptx
description: 当任务涉及 presentation、deck、slides 或 .pptx 文件作为输入或输出时使用，包括读取与提取内容、创建演示文稿、常规编辑、合并或拆分幻灯片、版式调整和渲染验证。不用于只需要网页幻灯片且明确选择 HTML 的任务。
version: "2.0.0"
license: AGPL-3.0-only
---

# PPTX 演示文稿处理

使用 `python-pptx` 完成普通 `.pptx` 的读取、创建和编辑；LibreOffice 仅作为本机已有时的可选渲染器。

## 不可违反的规则

1. 不覆盖输入文件，始终另存为新路径。
2. 创建前先明确受众、目的、比例、页数、大纲、语言和视觉基调。
3. 编辑前检查母版、主题、动画、宏、签名、SmartArt、嵌入对象和外部链接。
4. Python 依赖只安装到会话临时 venv，不全局安装、不污染用户项目。
5. 查询、安装、图片下载和字体获取不得静默联网。
6. 保存后重新打开验证；有版式要求时再做视觉渲染。
7. 不承诺 PowerPoint 专有特性完全保真。

## 路由

- **只读/摘要/提取大纲**：先尝试 Domi 内置 Read 或附件解析；不足时用 `python-pptx`。
- **从零创建**：先确定故事线和版式系统，再生成。
- **编辑已有文件**：复制到新路径，使用已有 layouts，做最小改动。
- **严格保留动画/母版/宏/签名**：优先只读建议或用户指定的原生 PowerPoint 自动化方案。

## 创建前确认

至少确定：

- 谁看、在哪里展示、希望观众采取什么行动；
- 16:9、4:3 或自定义比例；
- 标题页、章节页、内容页、数据页和结尾页结构；
- 是否提供品牌字体、颜色、Logo、模板和图片；
- 是否需要演讲者备注、图表或可编辑元素。

没有素材时不要擅自联网抓图。可以使用纯色块、几何图形和用户提供的本地资产。

## 临时环境

```bash
python -m pip index versions python-pptx
python -m venv "<session-temp>/pptx-work/venv"
"<session-temp>/pptx-work/venv/Scripts/python.exe" -m pip install "python-pptx==<verified-version>"
```

POSIX 使用 `venv/bin/python`。记录精确版本、官方来源、许可证和用途。2026-08-29 参考基线为 `python-pptx 1.0.2`，MIT；执行任务时重新查询。

## 读取与盘点

```python
from pathlib import Path
from pptx import Presentation

source = Path("input.pptx")
prs = Presentation(source)
print("slides", len(prs.slides))
print("size", prs.slide_width, prs.slide_height)
for index, slide in enumerate(prs.slides, start=1):
    texts = [shape.text.strip() for shape in slide.shapes if hasattr(shape, "text") and shape.text.strip()]
    print(index, texts)
```

普通文本提取不会覆盖图片内文字、图表数据、备注、SmartArt 或所有嵌入对象；说明提取范围。

## 从零创建

```python
from pathlib import Path
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt

output = Path("output/project-update.pptx")
output.parent.mkdir(parents=True, exist_ok=True)
if output.exists():
    raise FileExistsError(output)

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)

# 标题页
slide = prs.slides.add_slide(prs.slide_layouts[6])
box = slide.shapes.add_textbox(Inches(0.9), Inches(2.2), Inches(11.5), Inches(1.4))
paragraph = box.text_frame.paragraphs[0]
paragraph.text = "项目进展"
paragraph.font.size = Pt(34)
paragraph.font.bold = True
paragraph.font.color.rgb = RGBColor(28, 52, 91)
paragraph.alignment = PP_ALIGN.CENTER

# 内容页
slide = prs.slides.add_slide(prs.slide_layouts[5])
slide.shapes.title.text = "本阶段成果"
body = slide.shapes.add_textbox(Inches(1.0), Inches(1.7), Inches(11.0), Inches(4.8))
for index, text in enumerate(["完成核心流程", "建立验证门禁", "明确下一阶段风险"]):
    p = body.text_frame.paragraphs[0] if index == 0 else body.text_frame.add_paragraph()
    p.text = text
    p.font.size = Pt(24)
    p.space_after = Pt(12)

prs.save(output)
print(output)
```

保持统一的边距、字号、颜色和对齐；一页只表达一个主要结论。数据图表必须标注单位、时间范围和来源。

## 编辑已有演示文稿

```python
from pathlib import Path
from pptx import Presentation

source = Path("input.pptx")
output = Path("output/input-edited.pptx")
if source.resolve() == output.resolve() or output.exists():
    raise RuntimeError("输出必须是新的非现有路径")

prs = Presentation(source)
for slide in prs.slides:
    for shape in slide.shapes:
        if hasattr(shape, "text") and "旧名称" in shape.text:
            # 设置完整 text 可能重建文本 runs；需要保留行内格式时逐 run 检查。
            shape.text = shape.text.replace("旧名称", "新名称")

output.parent.mkdir(parents=True, exist_ok=True)
prs.save(output)
```

修改现有文件时优先复用其 layout 和主题，不要把全部页面重建成默认模板。

## 验证

```python
from pathlib import Path
from pptx import Presentation

output = Path("output/project-update.pptx")
check = Presentation(output)
assert output.stat().st_size > 0
assert len(check.slides) > 0
for index, slide in enumerate(check.slides, start=1):
    assert len(slide.shapes) > 0, f"empty slide: {index}"
print({"slides": len(check.slides), "size": [check.slide_width, check.slide_height]})
```

再检查：标题和关键文本存在、图片路径有效、图表数据范围正确、比例符合要求、没有意外空白页。

若本机已有 LibreOffice，可将副本渲染成 PDF：

```bash
soffice --headless --convert-to pdf --outdir "<session-temp>/pptx-preview" "output/project-update.pptx"
```

视觉抽查每页溢出、遮挡、字体替换、对比度、图片裁切和图表标签。无法渲染时明确说明只完成结构验证。

## 保真边界

- `python-pptx` 不完整支持动画、切换、复杂母版/主题编辑、SmartArt、嵌入对象和某些扩展图表。
- `.pptm` 宏和数字签名不属于普通 `.pptx` 安全编辑范围；修改可能移除宏或使签名失效。
- LibreOffice 与 PowerPoint 的字体、布局和媒体行为可能不同。
- 这些特性是交付核心时，保留原件并使用用户指定的原生 Office 流程。

## 交付说明

报告输出路径、是否保留原件、页数和比例、完成的修改、依赖版本和许可证、结构/视觉验证结果，以及动画、母版、宏、签名和嵌入对象等未验证风险。
