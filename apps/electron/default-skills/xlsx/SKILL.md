---
name: xlsx
description: 当电子表格文件是主要输入或输出时使用，包括读取、创建、编辑、清洗或转换 .xlsx、.xlsm、.csv、.tsv，以及处理公式、格式、Excel 表格、图表、冻结窗格和数据校验。如果主要交付物不是电子表格，则不要触发。
version: "2.0.0"
license: AGPL-3.0-only
---

# 电子表格处理

使用 `openpyxl` 处理 `.xlsx/.xlsm`，使用 Python 标准库 `csv` 处理简单 `.csv/.tsv`。公式重算需要 Excel 或 LibreOffice；`openpyxl` 本身不计算公式。

## 不可违反的规则

1. 不覆盖输入文件；输出到新的明确路径。
2. 修改前盘点 sheet、公式、合并单元格、命名区域、表格、图表、校验、外部链接、宏和数据透视表。
3. 先判断数据类型，不把日期、ID、前导零、百分比和货币误当普通数字。
4. Python 依赖只安装到会话临时 venv，不全局安装、不污染用户项目。
5. 查询和安装依赖不得静默联网。
6. 保存后重新打开，检查公式、样式、行列数和关键单元格。
7. 不声称 `openpyxl` 已重算公式，也不承诺高级 Excel 对象完全保真。

## 路由

- **只读分析**：先尝试 Domi 内置 Read/附件解析；需要结构化数据时用 `openpyxl` 或 `csv`。
- **CSV/TSV 清洗**：优先标准库；明确编码、分隔符、换行和列类型。
- **创建/编辑 XLSX**：使用 `openpyxl`。
- **XLSM**：只有用户接受风险时使用 `keep_vba=True`，且输出仍为 `.xlsm`。
- **公式需要最新结果**：用 Excel 或 LibreOffice 打开输出副本重算并保存，再重新读取。
- **数据透视表、Power Query、外部连接、签名或复杂图表**：先报告风险，必要时只读交付。

## 临时环境

```bash
python -m pip index versions openpyxl
python -m venv "<session-temp>/xlsx-work/venv"
"<session-temp>/xlsx-work/venv/Scripts/python.exe" -m pip install "openpyxl==<verified-version>"
```

POSIX 使用 `venv/bin/python`。记录精确版本、官方来源、许可证和用途。2026-08-29 参考基线为 `openpyxl 3.1.5`，MIT；执行任务时重新查询。

## 读取和盘点

```python
from pathlib import Path
from openpyxl import load_workbook

source = Path("input.xlsx")
wb = load_workbook(source, data_only=False, read_only=True)
print("sheets", wb.sheetnames)
for ws in wb.worksheets:
    print(ws.title, ws.max_row, ws.max_column)
    for row in ws.iter_rows(min_row=1, max_row=min(ws.max_row, 5), values_only=True):
        print(row)
```

`max_row/max_column` 可能受历史格式影响，不一定等于真实数据范围。大文件使用 `read_only=True` 并限制采样，不要把整本工作簿打印进上下文。

## 创建工作簿

```python
from pathlib import Path
from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.styles import Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.table import Table, TableStyleInfo

output = Path("output/monthly-report.xlsx")
output.parent.mkdir(parents=True, exist_ok=True)
if output.exists():
    raise FileExistsError(output)

wb = Workbook()
ws = wb.active
ws.title = "月报"
ws.append(["项目", "计划", "完成", "完成率", "状态"])
for row in [("A", 10, 8), ("B", 12, 12), ("C", 9, 6)]:
    ws.append([*row, None, "正常"])

for row in range(2, ws.max_row + 1):
    ws.cell(row, 4, f"=IFERROR(C{row}/B{row},0)")
    ws.cell(row, 4).number_format = "0.0%"

for cell in ws[1]:
    cell.font = Font(bold=True, color="FFFFFF")
    cell.fill = PatternFill("solid", fgColor="1C345B")

ws.freeze_panes = "A2"
ws.column_dimensions["A"].width = 18
ws.column_dimensions["D"].width = 12

validation = DataValidation(type="list", formula1='"正常,关注,阻塞"')
ws.add_data_validation(validation)
validation.add(f"E2:E{ws.max_row}")

table = Table(displayName="MonthlyData", ref=f"A1:E{ws.max_row}")
table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)
ws.add_table(table)

chart = BarChart()
chart.title = "完成情况"
chart.add_data(Reference(ws, min_col=3, min_row=1, max_row=ws.max_row), titles_from_data=True)
chart.set_categories(Reference(ws, min_col=1, min_row=2, max_row=ws.max_row))
ws.add_chart(chart, "G2")

wb.save(output)
assert load_workbook(output, data_only=False)["月报"]["D2"].value.startswith("=")
print(output)
```

公式应写入单元格，不要用已经计算出的常量替代用户要求保留的公式。

## 编辑已有工作簿

```python
from pathlib import Path
from openpyxl import load_workbook

source = Path("input.xlsx")
output = Path("output/input-edited.xlsx")
if source.resolve() == output.resolve() or output.exists():
    raise RuntimeError("输出必须是新的非现有路径")

wb = load_workbook(source, data_only=False)
ws = wb["数据"]
ws["F1"] = "备注"
for row in range(2, ws.max_row + 1):
    ws.cell(row, 6, "已复核")

output.parent.mkdir(parents=True, exist_ok=True)
wb.save(output)
```

只修改目标 sheet 和单元格；不要为了“统一格式”重写无关区域。

## CSV/TSV

```python
import csv
from pathlib import Path

source = Path("input.csv")
output = Path("output/cleaned.csv")
with source.open("r", encoding="utf-8-sig", newline="") as src:
    rows = list(csv.DictReader(src))

fields = ["name", "amount"]
with output.open("w", encoding="utf-8-sig", newline="") as dst:
    writer = csv.DictWriter(dst, fieldnames=fields)
    writer.writeheader()
    for row in rows:
        writer.writerow({"name": row["name"].strip(), "amount": row["amount"].strip()})
```

保留前导零和长 ID 时按文本处理。转换前记录原编码、分隔符和列名；不要静默丢弃额外列。

## 公式与重算

- `data_only=False` 读取公式文本。
- `data_only=True` 只读取文件中已有的缓存结果；缓存可能过期。
- `openpyxl` 不执行公式。需要最新结果时用 Excel/LibreOffice 重算输出副本，并说明计算引擎。
- 不要用 `data_only=True` 加载后再保存需要保留公式的工作簿。

## XLSM 与高级对象

```python
from openpyxl import load_workbook
wb = load_workbook("input.xlsm", keep_vba=True, data_only=False)
wb.save("output/input-edited.xlsm")
```

`keep_vba=True` 只尝试保留 VBA 包，不理解或执行宏。ActiveX、签名、自定义 XML、Power Query、外部连接、数据模型、数据透视缓存、切片器和复杂图表仍可能损坏；发现后先报告风险。

## 验证

重新打开输出并检查：

- sheet 名、可见性、行列数和关键单元格；
- 公式字符串、数字格式、日期、前导零和百分比；
- 合并单元格、冻结窗格、表格、校验和图表数量；
- CSV/TSV 编码、分隔符和换行；
- 输入文件大小和修改时间未变化；
- 若执行重算，抽查公式结果并记录计算引擎。

无法用 Excel/LibreOffice 验证时明确写“已完成结构验证，未完成原生表格应用验证”。

## 交付说明

报告输入/输出路径、清洗与编辑内容、依赖版本和许可证、公式是否重算、结构/原生应用验证结果，以及宏、签名、外部链接、数据透视表和高级对象的保真风险。
