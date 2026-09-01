---
name: docx
description: 当任务的输入或交付物涉及 Microsoft Word .docx 文档时使用，包括读取与提取、创建专业报告、编辑正文和样式、处理表格与图片、页眉页脚、分页和页码。不用于 PDF、电子表格、演示文稿，或只需普通文本而不需要 Word 文件的任务。
version: "2.0.0"
license: AGPL-3.0-only
---

# DOCX 文档处理

用可回退、可验证的方式读取、创建和编辑 `.docx`。默认使用 `python-docx`；LibreOffice 只作为本机已有时的可选渲染器。

## 不可违反的规则

1. **先保留原文件**：不得覆盖输入文档；输出使用新的明确路径。
2. **先检查再修改**：记录页眉、页脚、表格、图片和高级对象等保真风险。
3. **依赖隔离**：需要 Python 库时，只在 Domi 会话临时目录创建 venv；禁止全局安装或污染用户项目。
4. **联网透明**：查询或安装依赖前说明用途；不得静默联网。
5. **重新打开验证**：保存后用独立加载步骤检查输出；复杂版式再做视觉验证。
6. **诚实披露边界**：不承诺宏、签名、复杂修订、域代码、嵌入对象或高级版式无损。

## 工作流

### 1. 判断任务类型

- **只读/摘要/问答**：先尝试 Domi 内置 Read 或附件解析；足够时不要安装依赖。
- **创建新文档**：确认受众、语言、纸张、标题层级、表格、图片、页眉页脚和输出路径。
- **编辑现有文档**：先复制到新路径，再做最小修改。
- **旧 `.doc`**：不要直接当作 `.docx`；仅在本机已有 LibreOffice 或 Word 时转换副本。

### 2. 检查输入和输出

确认：

- 输入存在且扩展名正确；
- 输出路径与输入不同，且不会覆盖已有文件；
- 是否包含宏、数字签名、修订、批注、自动目录、域、SmartArt、嵌入对象或复杂分节；
- 用户是否要求严格视觉保真。

发现高风险特性时，优先只读交付或请求用户接受可能降级的副本。

### 3. 建立临时工具环境

使用系统提示给出的会话私有目录；不可用时使用 OS 临时目录。不要把 venv、缓存或中间产物放进用户项目。

```bash
python -m pip index versions python-docx
python -m venv "<session-temp>/docx-work/venv"
"<session-temp>/docx-work/venv/Scripts/python.exe" -m pip install "python-docx==<verified-version>"
```

POSIX 使用 `venv/bin/python`。安装前核对官方来源和许可证；记录精确版本、查询日期和用途。2026-08-29 已核对的参考基线为 `python-docx 1.2.0`，MIT；执行任务时仍应重新查询。

## 读取与检查

当内置 Read 不足时，用 `python-docx` 做结构化提取：

```python
from pathlib import Path
from docx import Document

source = Path("input.docx")
doc = Document(source)

print("paragraphs", len(doc.paragraphs))
print("tables", len(doc.tables))
for paragraph in doc.paragraphs:
    text = paragraph.text.strip()
    if text:
        print(text)
for index, table in enumerate(doc.tables, start=1):
    print("TABLE", index)
    for row in table.rows:
        print([cell.text for cell in row.cells])
```

提取结果只是结构视图。图片中的文字、文本框、页眉页脚、脚注、域和绘图对象可能不在普通段落序列中；不要把缺失误判为源文件没有内容。

## 创建新文档

下面是原创最小模板；按任务删减，不要机械复制无关结构：

```python
from pathlib import Path
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Cm, Pt

output = Path("output/report.docx")
output.parent.mkdir(parents=True, exist_ok=True)
if output.exists():
    raise FileExistsError(output)

doc = Document()
section = doc.sections[0]
section.top_margin = Cm(2.2)
section.bottom_margin = Cm(2.2)
section.left_margin = Cm(2.5)
section.right_margin = Cm(2.5)

normal = doc.styles["Normal"]
normal.font.name = "Arial"
normal.font.size = Pt(10.5)

title = doc.add_heading("项目进展报告", level=0)
title.alignment = WD_ALIGN_PARAGRAPH.CENTER

doc.add_heading("摘要", level=1)
doc.add_paragraph("本报告汇总本阶段结果、风险与后续行动。")

doc.add_heading("关键指标", level=1)
table = doc.add_table(rows=1, cols=3)
table.style = "Table Grid"
for cell, value in zip(table.rows[0].cells, ["指标", "当前值", "状态"]):
    cell.text = value
for values in [("完成项", "12", "正常"), ("风险项", "2", "跟进中")]:
    cells = table.add_row().cells
    for cell, value in zip(cells, values):
        cell.text = value

footer = section.footer.paragraphs[0]
footer.text = "Domi 生成 · 请复核后发布"
footer.alignment = WD_ALIGN_PARAGRAPH.CENTER

doc.save(output)
print(output)
```

需要图片时，只使用用户提供或许可证明确的本地文件，并显式设置尺寸；不要从网络随意抓图。

## 编辑现有文档

只修改任务要求的内容，并另存：

```python
from pathlib import Path
from docx import Document

source = Path("input.docx")
output = Path("output/input-edited.docx")
if source.resolve() == output.resolve() or output.exists():
    raise RuntimeError("输出必须是新的非现有路径")

doc = Document(source)
replacements = {"旧项目名": "新项目名"}
for paragraph in doc.paragraphs:
    for old, new in replacements.items():
        if old in paragraph.text:
            # 直接设置 text 会重建 runs，可能丢失行内格式；仅在用户接受时使用。
            paragraph.text = paragraph.text.replace(old, new)

output.parent.mkdir(parents=True, exist_ok=True)
doc.save(output)
```

如果需要保留行内格式，应逐个 run 修改，但跨 run 的文本可能无法直接匹配。先检查 run 边界，不要假装简单替换能无损处理所有情况。

## 验证

### 结构验证

```python
from pathlib import Path
from docx import Document

output = Path("output/report.docx")
check = Document(output)
assert output.stat().st_size > 0
assert any(p.text.strip() for p in check.paragraphs)
print({
    "paragraphs": len(check.paragraphs),
    "tables": len(check.tables),
    "sections": len(check.sections),
})
```

根据任务增加断言：标题存在、表格行列正确、图片关系存在、页眉页脚存在、输入文件的大小和修改时间未变化。

### 可选视觉验证

若本机已有 LibreOffice 且任务依赖分页或版式，可把输出副本转换成 PDF 再用 Read 检查：

```bash
soffice --headless --convert-to pdf --outdir "<session-temp>/docx-preview" "output/report.docx"
```

无法渲染时明确写“已完成结构验证，未完成视觉渲染验证”。

## 保真边界

- `.docm` 宏和数字签名不属于安全编辑范围；修改通常会使签名失效。
- `python-docx` 不完整支持 Track Changes、批注、自动目录、域刷新、SmartArt、嵌入对象和所有 OOXML 扩展。
- Word 与 LibreOffice 的字体替换、分页和域计算可能不同。
- 如果这些特性是交付核心，优先保留原件、仅提供内容建议，或使用用户指定的原生 Office 自动化方案。

## 交付说明

最终报告：输入与输出路径、完成的操作、依赖版本和许可证、结构/视觉验证结果、未验证项及保真风险。始终让用户能够比较和回退。
