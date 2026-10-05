# 布料裁片排样系统

面向小型服装工作室的布料裁片排样（Nesting）Web 应用。**同一订单可由多卷布完成**：登记每卷的卷号、布幅宽度、可用长度和矩形瑕疵，系统自动把每件裁片排到具体卷的卷内坐标与方向上，尽量排入全部裁片，再尽量减少启用卷数和总占用长度。支持为裁片指定必用卷、锁定已确认的卷号与位置、手动跨卷移动。

## 功能

- **多卷排样**：一个方案登记多卷布（卷号、各卷宽度/可用长度、各卷矩形瑕疵）；排样结果给出每件裁片的**卷号、卷内坐标 (x,y) 与方向 (0°/180°)**
- **优化目标（字典序）**：① 先尽量排入全部裁片（绝不为减少用卷放弃可排入的件）→ ② 启用卷数最少 → ③ 各卷总占用长度最短 → ④ 接触周长等平局裁决
- **必用卷约束**：可为每件裁片（创建时也可按型号）指定必用卷；优化只在该卷内为其找位，手动跨卷移动不得违反；无效卷号、宽度/长度容不下裁片的必用卷约束明确拒绝
- **锁定重优化**：可锁定已确认裁片的**卷号和卷内位置**；锁定件与各卷瑕疵始终固定，仅重新排布未锁定裁片
- **裁片**：简单多边形轮廓（整数毫米顶点）、件数、可选是否允许旋转 180°；禁旋转件始终保持原方向
- **瑕疵区**：每卷独立登记矩形瑕疵，裁片自动避开
- **手动跨卷调整**：画布上卷内拖拽，或输入目标卷 + 卷内精确坐标/旋转；按**目标卷布边、该卷瑕疵及该卷已排裁片**精确校验，冲突时指出冲突对象（含卷名），原方案不变；锁定件须先解锁
- **未排区 / 部分方案**：无可行位置的裁片列入未排区并给出原因（如必用卷长度不足），方案保持「部分方案」状态，绝不标为完成
- **按卷裁剪进度（不可回退）**：在任意一卷上以整数毫米切线逐段确认裁剪；切线必须严格位于上一切线之后、不超过卷长，且不得穿过任何已排未裁件（边接触允许）。切线之前的已排件标记为**已裁**：其卷号、卷内坐标、方向与必用卷此后均不可修改，也不能移回未排区；优化只重排未裁件，且本卷所有未裁件只能位于切线之后。无效切线、无新增已裁件或违反边界的操作会说明原因并保持原方案
- **裁剪交接单（不可改快照）**：每次确认切线且确有新裁件时，与裁剪进度**同一事务**生成一张交接单，定格该次切线前后位置、卷号及本次新裁件的 ID、件号、纸样版次、轮廓、坐标与方向；按卷与确认顺序查询，网页可查看并打印。同卷并发确认不会产生重复或倒序记录；后续纸样改版、重新排样均不改写旧交接单；升级前已裁件缺少逐次切线边界，标识为「无批次历史」，不推造交接单
- **尾料移交（跨方案领用）**：来源卷已有确认切线、切线后没有未裁排入件且剩余长度 > 0 时，可将切线后**整幅尾料区间**登记移交给另一排样方案：跨越区间起点的瑕疵沿切线**裁截**，目标卷瑕疵坐标以该起点为零重算。领入的尾料是目标方案的**独立卷**，正常参与移动、优化与后续切线裁剪；移交台账可追溯来源方案、来源卷及原始区间。尾料只能跨方案领用一次，重复或并发领用返回 409 冲突且**两方案均不产生部分变更**。登记后来源卷**封卷**：不得再排入裁片或推进切线；条件不满足、目标/来源不存在时逐条说明原因并保持原状态
- **改版纸样（按裁片型号）**：收到改版纸样时可按型号提交新多边形轮廓、是否允许 180° 旋转及目标总件数；再次修订仍针对该型号**当前纸样**（历史版次保留）。**已裁件**继续使用各自裁剪时定格的旧轮廓，卷号、坐标、方向、必用卷与裁剪清单不变；其余同型号未裁件改用新轮廓，原必用卷约束不变。缩减先删未排件、再按 placement ID 降序删未锁定已排件（已裁件、锁定件绝不删除）；扩增件进入未排区（件号接最大号之后）。锁定件必须在**原位**满足新轮廓、旋转许可、布边、切线后区域、瑕疵及与其他保留件不重叠，否则**整次拒绝**；未锁定已排件（不分型号）按 ID 升序在原位校验，失效者退回未排区并在原因中注明冲突对象。前置可行性：尚有未裁件时至少一卷切线后剩余段能容纳新外接尺寸，且各必用卷也须容纳；新轮廓必须合法、目标件数为正整数
- **页面可切换查看各卷**：多卷方案顶部出现卷标签（卷号、尺寸、是否启用、本卷占用长度）；单卷方案与旧数据不显示切换条
- **输入校验**：非法轮廓（自交、退化、非整数坐标）、非法尺寸、重复卷号、瑕疵越界、必用卷不可行等在创建时即逐项指出对象并拒绝
- **向后兼容**：旧单卷入参（`fabricWidth/fabricLength/defects`）、旧的查询/移动/优化调用与单卷响应字段（`job.fabricWidth`、顶层 `defects`、不带 `rollId` 的 move）继续可用；旧库数据自动迁移为一卷「默认卷」按单卷显示

## 技术栈

- 后端：Node.js + Express，SQLite（better-sqlite3，WAL 模式）
- 前端：原生 HTML/Canvas/JS，无构建步骤
- 排样：每卷独立 1mm 占用栅格 + 左下启发式 + 跨卷压实局部搜索（可腾空整卷）；手动移动采用精确几何判定

## 快速开始

### 方式一：Docker Compose（推荐，一键启动）

```bash
docker compose up --build
```

启动后访问 **http://localhost:3000**

### 方式二：本地运行

```bash
npm install
npm start
```

访问 **http://localhost:3000**

### 运行测试

```bash
npm test        # 几何、单卷/多卷排样不变量、输入校验与 HTTP API/裁剪/交接单/改版/尾料移交共 78 项测试
```

## 配置

| 环境变量   | 默认值                | 说明                     |
| ---------- | --------------------- | ------------------------ |
| `PORT`     | `3000`                | HTTP 监听端口            |
| `DATA_DIR` | `./data`（容器内 `/app/data`） | SQLite 数据库文件目录 |

## 使用流程（多卷）

1. 左侧「新建排样方案」：点 **＋添加卷** 登记每一卷——卷号（如 A卷/B卷）、布幅宽度、可用长度，并为该卷添加矩形瑕疵 (x,y,宽,高)。可点「填入示例」生成两卷示例。
2. 在「裁片型号」中填写名称、顶点（每行 `x,y`）、件数、是否允许旋转 180°，以及可选的**必用卷**（按卷序号选择，或留空表示不限卷，由优化器自动选卷）。
3. 点击「创建方案」——非法输入（含无效必用卷、必用卷太窄、卷号重复）会逐条指出问题对象。
4. 点击「优化排样」——顶部卷标签与画布展示各卷结果：红块为该卷瑕疵，绿色虚线为该卷实际占用长度，🔒 为锁定件；徽标区显示启用卷数/总占用长度。
5. 顶部卷标签切换查看各卷；在卷内可直接拖动裁片微调。**跨卷移动**：选中裁片后在左侧「目标卷」选目标卷、填卷内坐标后「应用位置」。
6. 冲突移动（压目标卷布边/瑕疵/已排件，或违反必用卷）会被拒绝并列出冲突对象，原方案不变。
7. 勾选「锁定」后再次「优化排样」，锁定件的卷号与位置保持固定。
8. 顶部状态徽标：草稿 / 部分方案（列出未排入裁片及原因）/ 完整方案。
9. **逐卷裁剪**：切换到要裁的卷标签，在顶部「✂ 裁剪进度」条查看本卷切线与剩余长度，在「新切线」输入整数毫米后点 **确认切线（不可回退）**。画布以紫色实线标出切线、紫色阴影标出已裁段，已裁件带 ✂ 标记且不可再拖动；卷标签显示 `✂切线 … · 已裁 N 件`，下方进度面板列出每卷切线与已裁件（点击可定位）。确认后再次「优化排样」，未裁件只会重排到切线之后。
10. **裁剪交接单**：每次确认切线（且确有新裁件）自动生成一张不可改交接单。画布上方「🧾 裁剪交接单」面板按卷与确认顺序列出各单（切线区间、新裁件数、确认时间），点「明细」展开本次新裁件的 ID、件号、纸样版次、外接、坐标与方向；点「打印」打开打印页（`batch.html`，含轮廓缩略图与签字栏，可直接打印/另存 PDF），「打印全部交接单」一次输出该方案全部单。升级前已裁件在面板与打印页中标识为「无批次历史」。
11. **尾料移交（跨方案领用）**：在某卷确认切线、且切线后已无未裁排入件（剩余长度 > 0）后，工作区出现「♻ 尾料移交」面板：
    - 「可领用尾料」列出**其他方案**满足条件的卷（来源方案/卷号、布幅、切线、尾料长度、随尾料携带的瑕疵），可改领入卷号后点「领用到本方案」；
    - 领用成功后本方案新增一卷 `♻尾料` 卷（默认卷号如 `A卷·尾料(#1)`），它与普通卷完全一样可切换查看、拖动/跨卷移动、优化排样、确认切线并生成交接单；卷标签与画布标注其来源方案、来源卷及原始区间；
    - 「暂不可领用的裁剪卷」可展开查看其他方案已切线但尚不满足条件的卷及逐条原因（如切线后仍有未裁排入件、剩余长度为 0）；
    - 来源卷领出后显示 `🧊尾料已移交·封卷`，切线输入框与确认按钮禁用，画布叠加封卷标识；该卷不能再排入裁片或推进切线；
    - 重复或并发领用同一尾料时后到者收到冲突提示，来源与目标双方均无部分变更。
12. **改版纸样**：左侧「改版纸样（按型号）」选择型号（显示当前版次/件数与已裁、锁定、已排、未排计数），可点「读入当前轮廓」自动填入，再修改顶点、目标总件数与旋转许可后「提交改版」。已裁件画布上标注其定格版次（如 `v1`），锁定件无法在原位满足新轮廓时整次拒绝并逐条列出原因。

## HTTP API

所有接口均以 JSON 收发；端口默认 3000。

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET | `/api/jobs` | 方案列表（含 `rollCount`、`pieceCount`，保留 `fabricWidth/fabricLength`） |
| POST | `/api/jobs` | 创建方案（多卷 `rolls` 或旧单卷字段；校验失败 400 + 逐项原因） |
| GET | `/api/jobs/:id` | 方案完整状态（`rolls`、`defectsByRoll`、每件 `rollId/requiredRollId`，并保留旧字段） |
| DELETE | `/api/jobs/:id` | 删除方案（级联删除其卷） |
| POST | `/api/jobs/:id/optimize` | 优化排样（保留锁定件与各卷瑕疵；先排全、再省卷、再省长度） |
| POST | `/api/jobs/:id/placements/:pid/move` | 移动/旋转/手动排入（可跨卷，`rollId` 指定目标卷；冲突 409 + 冲突对象，原方案不变） |
| POST | `/api/jobs/:id/placements/:pid/lock` | 锁定/解锁 `{locked: bool}` |
| POST | `/api/jobs/:id/placements/:pid/unplace` | 移回未排区（保留必用卷约束） |
| POST | `/api/jobs/:id/placements/:pid/require-roll` | 设置/取消单件必用卷 `{rollId}` / `{rollId: null}` |
| POST | `/api/jobs/:id/cuts` | 确认一卷的裁剪切线（不可回退）：`{rollId, cutLine}`，单卷方案可省略 `rollId`；成功时与裁剪进度原子生成裁剪交接单 |
| GET | `/api/jobs/:id/cuts` | 查询裁剪进度：各卷切线与已裁件清单（方案详情 `GET /api/jobs/:id` 也内含 `cuts`、`rolls[].cutLine/cutCount`、`placements[].cut`） |
| GET | `/api/jobs/:id/cut-batches` | 查询裁剪交接单（不可改快照）：按卷与确认顺序排列，`?rollId=N` 可只看一卷；附无批次历史的已裁件 |
| GET | `/api/jobs/:id/cut-batches/:bid` | 单张裁剪交接单详情（打印页数据源） |
| GET | `/api/remnants` | 尾料总览：`available` 可领用尾料、`unavailable` 已切线但条件不满足的卷（含原因）、`transferred` 已移交台账；`?targetJobId=N` 排除目标方案自身并校验目标存在 |
| POST | `/api/jobs/:id/remnant-claims` | 把来源卷切线后整幅尾料领用到方案 `:id`：`{sourceRollId, label?}`；成功返回目标方案完整状态并附 `remnantClaim` 摘要；冲突 409 且双方无部分变更 |
| POST | `/api/jobs/:id/piece-types/:tid/revisions` | 按型号提交改版纸样：`{vertices, quantity, allowRotate}`；成功返回完整方案状态并附 `revision` 结果摘要，校验失败 400/409 且原方案不变 |

### 创建方案（多卷）

```bash
curl -s -X POST http://localhost:3000/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "夹克 M 码",
    "rolls": [
      {"label": "A卷", "width": 1600, "length": 5000,
       "defects": [{"x": 1150, "y": 300, "w": 200, "h": 250}]},
      {"label": "B卷", "width": 1500, "length": 4000, "defects": []}
    ],
    "pieces": [
      {"name": "前片", "vertices": [[0,0],[620,0],[620,950],[0,950]],
       "quantity": 2, "allowRotate": true},
      {"name": "袖片", "vertices": [[0,0],[360,0],[360,560],[180,460],[0,560]],
       "quantity": 2, "allowRotate": true, "requiredRoll": 2}
    ]
  }'
```

- `rolls[].label`：卷号（可省略，默认 `卷1/卷2…`，同方案内唯一）；`requiredRoll` 可用**卷序号（1 起）或卷号文本**。
- 旧单卷调用继续支持：`{"name","fabricWidth","fabricLength","defects":[...],"pieces":[...]}`，系统自动建一卷「默认卷」。

### 优化排样

```bash
curl -s -X POST http://localhost:3000/api/jobs/1/optimize
```

返回（节选）：

```json
{
  "job": {"id": 1, "rollCount": 2, "status": "complete", "usedLength": 1600,
          "fabricWidth": 1600, "fabricLength": 5000},
  "rolls": [
    {"id": 1, "seq": 1, "label": "A卷", "width": 1600, "length": 5000, "used": false, "usedLength": 0},
    {"id": 2, "seq": 2, "label": "B卷", "width": 1500, "length": 4000, "used": true,  "usedLength": 1600}
  ],
  "placements": [
    {"id": 1, "rollId": 2, "requiredRollId": 2, "name": "袖片", "seq": 1,
     "x": 0, "y": 0, "rotation": 0, "placed": true, "locked": false, "bw": 360, "bh": 560, "reason": null}
  ],
  "unplaced": []
}
```

部分方案时 `job.status="partial"`，`unplaced` 中每件带 `reason`（如「必用卷「B卷」可用长度 4000mm 内找不到可行位置……」）。

### 手动移动 / 跨卷移动

```bash
# 卷内移动（单卷方案或仍在本卷时 rollId 可省略；多卷省略=保持原卷）
curl -s -X POST http://localhost:3000/api/jobs/1/placements/3/move \
  -H 'Content-Type: application/json' \
  -d '{"rollId": 2, "x": 400, "y": 1200, "rotation": 180}'
```

冲突响应（HTTP 409，原方案不变）：

```json
{"error": "裁片「袖片#1」移动后与以下对象冲突，已保留原方案",
 "conflicts": ["卷「B卷」瑕疵区#2（100,100 200×200mm）", "卷「B卷」裁片「前片#2」"]}
```

违反必用卷：`409 {"error":"裁片「袖片#1」指定了必用卷「B卷」，不能移动到卷「A卷」", ...}`；
无效目标卷：`400 {"error":"目标卷不存在：方案中没有 rollId=9 的卷（可用卷：1=A卷、2=B卷）"}`。

### 设置 / 取消必用卷

```bash
curl -s -X POST http://localhost:3000/api/jobs/1/placements/3/require-roll \
  -H 'Content-Type: application/json' -d '{"rollId": 1}'     # 必用A卷
curl -s -X POST http://localhost:3000/api/jobs/1/placements/3/require-roll \
  -H 'Content-Type: application/json' -d '{"rollId": null}'  # 取消
```

必用卷容不下裁片时返回 400：`"裁片「前片#1」外接尺寸 620×950mm 超过必用卷「窄卷」（500×5000mm），必用卷约束不可能满足，已拒绝"`。

### 按卷裁剪进度（不可回退）

车间按卷逐段裁剪时，先选定卷与整数毫米切线，确认切线之前已排的裁片即随该布段裁下。

```bash
# 确认切线：卷 2 的 1600mm 处下刀（单卷方案可省略 rollId）
curl -s -X POST http://localhost:3000/api/jobs/1/cuts \
  -H 'Content-Type: application/json' \
  -d '{"rollId": 2, "cutLine": 1600}'

# 查询全部卷的裁剪进度
curl -s http://localhost:3000/api/jobs/1/cuts
```

确认成功返回完整方案状态，并附带本次裁剪结果 `cut`（含本次生成的交接单号）：

```json
{
  "cut": {"rollId": 2, "label": "B卷", "previousCutLine": 400, "cutLine": 1600,
                "newCutPieceIds": [3, 4], "newCutCount": 2,
                "batchId": 3, "batchSeq": 2},
  "rolls": [
    {"id": 2, "seq": 2, "label": "B卷", "width": 1500, "length": 4000,
     "used": true, "usedLength": 1600, "cutLine": 1600, "cutCount": 4}
  ],
  "cuts": [
    {"rollId": 2, "seq": 2, "label": "B卷", "width": 1500, "length": 4000,
     "cutLine": 1600, "cutCount": 4,
     "cutPieces": [
       {"id": 5, "name": "袖片", "seq": 1, "x": 0, "y": 0, "rotation": 0, "requiredRollId": 2}
     ]}
  ],
  "placements": [
    {"id": 5, "rollId": 2, "x": 0, "y": 0, "rotation": 0, "placed": true, "cut": true}
  ]
}
```

切线规则（任一不满足返回 400/409 并**保持原方案不变**）：

- `cutLine` 必须为整数毫米，且严格**大于上一切线**（首条切线 ≥1mm）、不超过该卷 `length`；
- 切线**不得穿过任何已排的未裁件**：未裁件必须整体位于切线之前（随段裁下）或之后（保持未裁），与切线**边接触允许**（即裁片下沿 `y == cutLine` 合法）；
- 必须**至少有一件新增已裁件**；切线前移但没有任何新裁片（空段推进）也会被拒绝。

确认后的连带约束：

- 已裁件的**卷号、卷内坐标 (x,y)、方向、必用卷**均不可再改，对其 `move / lock / unplace / require-roll` 一律 409，也不能移回未排区；
- 手动移动与跨卷调整不得把未裁件放入目标卷已裁段，要求未裁件满足 **`y ≥ cutLine`**（边接触允许），否则 409；
- 重新「优化排样」时已裁件视同固定障碍，切线前布段作为全幅障碍带参与排样，未裁件只会排在切线之后，继续遵守瑕疵、必用卷与锁定约束；
- 在已有切线的卷上设置必用卷时，还会校验裁片外接长度不超过**切线后剩余长度** `length - cutLine`，否则 400。

典型失败响应：

```text
409 切线 300mm 穿过卷「B卷」上 3 件未裁裁片（裁片须整体位于切线之前或之后，边接触允许），已保留原方案
    conflicts: ["裁片「前片#1」（y 0~600mm）", ...]
409 切线 1500mm 无效：必须严格位于上一切线 1600mm 之后（裁剪进度不可回退），原方案不变
409 切线 1601mm 处没有新增已裁件（上一切线 1600mm 之后无整件位于该线之前的已排裁片），…
409 裁片「前片#1」不能放入卷「B卷」的已裁段（该卷切线为 1600mm，未裁件须满足 y≥1600，边接触允许），…
```

### 裁剪交接单（不可改快照）

车间每次确认某卷切线且确有新裁件时，系统与裁剪进度**同一事务**生成一张裁剪交接单：切线推进、新裁件标记、交接单及其明细快照要么全部生效，要么整体回滚（失败保持原状态）。交接单此后**不可改**——后续纸样改版、重新排样、裁片移动都不会回写；内容为确认时刻的定格快照。

```bash
# 查询方案全部交接单（按卷与确认顺序排列；?rollId=2 可只看一卷）
curl -s http://localhost:3000/api/jobs/1/cut-batches
curl -s 'http://localhost:3000/api/jobs/1/cut-batches?rollId=2'

# 查询单张交接单（打印页数据源）
curl -s http://localhost:3000/api/jobs/1/cut-batches/3
```

列表响应（节选）：

```json
{
  "job": {"id": 1, "name": "夹克 M 码"},
  "batches": [
    {"id": 3, "rollId": 2, "rollLabel": "B卷", "seq": 2,
     "previousCutLine": 400, "cutLine": 1600, "pieceCount": 2,
     "createdAt": "2026-10-05 10:23:22",
     "pieces": [
       {"placementId": 3, "name": "袖片", "seq": 1, "revision": 1,
        "vertices": [[0,0],[360,0],[360,560],[180,460],[0,560]],
        "bw": 360, "bh": 560, "x": 0, "y": 400, "rotation": 0},
       {"placementId": 4, "name": "袖片", "seq": 2, "revision": 1,
        "vertices": [[0,0],[360,0],[360,560],[180,460],[0,560]],
        "bw": 360, "bh": 560, "x": 360, "y": 400, "rotation": 0}
     ]}
  ],
  "legacyCutPieces": [
    {"placementId": 5, "name": "袖片", "seq": 3, "rollId": 1, "rollLabel": "A卷",
     "revision": 1, "x": 0, "y": 0, "rotation": 0, "batchHistory": false}
  ]
}
```

- 每张交接单记录：**单号**（`id`）、**卷号**、本卷第几单（`seq`，按确认顺序从 1 连续递增）、**切线前后位置**（`previousCutLine → cutLine`）、确认时间，以及**本次新裁件**的 ID（`placementId`）、件号（`seq`）、纸样版次（`revision`）、轮廓（`vertices` 及外接 `bw×bh`）、卷内坐标与方向。
- 同一卷内各单的切线区间**链式衔接**：本单 `previousCutLine` 等于上一单 `cutLine`；同卷并发确认由事务内重校验 + `UNIQUE(roll_id, seq)` 兜底，不会产生重复或倒序记录，并发失败者收到 409 且原状态不变。
- `legacyCutPieces`：升级前已裁的件缺少逐次切线边界，系统**不推造交接单**，仅在此如实标识为「无批次历史」（`batchHistory: false`）。
- 网页查看与打印：主页面「🧾 裁剪交接单」面板按卷分组列出各单并可展开明细；打印页 `batch.html?job=方案ID`（全部）或 `batch.html?job=方案ID&batch=交接单号`（单张）排版为含轮廓缩略图与签字栏的交接单，可直接打印或另存 PDF，追加 `&auto=1` 自动唤起打印。

### 尾料移交（切线后整幅尾料跨方案领用）

已裁卷切线之后的剩余布段可整幅移交给**另一个排样方案**继续使用。登记与领用在**同一事务**完成：来源卷封卷、目标方案新增独立尾料卷、瑕疵坐标换算与移交台账写入要么全部生效，要么整体回滚。

领用条件（全部满足才可领用）：

- 来源卷已有**确认切线**（`cutLine > 0`），且剩余长度 `length - cutLine > 0`（切线到卷末无尾料）；
- 切线之后**没有未裁排入件**（已排未裁件须先裁下、移走或移回未排区）；
- 尾料尚未被领用（每卷尾料只能跨方案领用一次）；
- 来源卷与目标方案属于**不同方案**；目标方案存在且卷数未达上限；领入卷号在目标方案内唯一。

瑕疵换算（目标卷坐标以区间起点 `cutLine` 为零）：

- 瑕疵整体在切线之前：随已裁段裁走，**不携带**；
- 瑕疵整体位于尾料区间内（含下沿与切线**边接触**）：平移为 `(x, y - cutLine)`；
- 瑕疵**跨越区间起点**（内部穿过切线）：沿切线**裁截**，只保留尾料内部分 `(x, 0, w, 截后高)`，并在响应中标记 `cutAtStart: true`。

```bash
# 1) 查询可领用尾料（网页打开目标方案时自动调用；targetJobId 用于排除自身并校验目标存在）
curl -s 'http://localhost:3000/api/remnants?targetJobId=2'

# 2) 把方案 1 的卷 1（切线 500mm 之后的 3500mm 整幅尾料）领用到方案 2
curl -s -X POST http://localhost:3000/api/jobs/2/remnant-claims \
  -H 'Content-Type: application/json' \
  -d '{"sourceRollId": 1}'
# 也可指定领入卷号：{"sourceRollId": 1, "label": "A卷尾料"}
```

尾料总览响应（节选）：

```json
{
  "targetJobId": 2,
  "available": [
    {"sourceJobId": 1, "sourceJobName": "夹克 M 码", "sourceRollId": 1, "sourceRollLabel": "A卷",
     "width": 1000, "cutLine": 500, "fromY": 500, "length": 3500,
     "defects": [
       {"x": 100, "y": 0, "w": 200, "h": 100, "cutAtStart": true},
       {"x": 100, "y": 400, "w": 200, "h": 200, "cutAtStart": false}
     ],
     "suggestedLabel": "A卷·尾料(#1)"}
  ],
  "unavailable": [
    {"sourceJobId": 3, "sourceRollId": 7, "sourceRollLabel": "C卷", "width": 1000,
     "cutLine": 500, "remaining": 3500,
     "reason": "切线 500mm 之后仍有 1 件未裁排入件（须先裁下、移走或移回未排区）",
     "blocking": ["裁片「前片#3」（y 600~1000mm）"]}
  ],
  "transferred": [
    {"id": 1, "sourceJobId": 1, "targetJobId": 2, "sourceRollId": 1, "targetRollId": 3,
     "sourceJobName": "夹克 M 码", "sourceRollLabel": "A卷", "width": 1000,
     "fromY": 500, "length": 3500, "createdAt": "2026-10-05 10:23:22"}
  ]
}
```

领用成功返回**目标方案完整状态**（与 `GET /api/jobs/:id` 同构），并附本次摘要：

```json
{
  "remnantClaim": {
    "transferId": 1, "sourceJobId": 1, "sourceJobName": "夹克 M 码",
    "sourceRollId": 1, "sourceRollLabel": "A卷",
    "fromY": 500, "width": 1000, "length": 3500,
    "targetRollId": 3, "targetRollSeq": 2, "targetRollLabel": "A卷·尾料(#1)",
    "defects": [{"x": 100, "y": 0, "w": 200, "h": 100, "cutAtStart": true}],
    "releasedRequiredPieceIds": []
  },
  "rolls": [
    {"id": 3, "seq": 2, "label": "A卷·尾料(#1)", "width": 1000, "length": 3500,
     "cutLine": 0, "cutCount": 0, "remnant": true, "remnantFrozen": false, "remnantTransferId": 1}
  ],
  "transfers": [
    {"id": 1, "direction": "inbound", "sourceJobId": 1, "targetJobId": 2,
     "sourceRollId": 1, "targetRollId": 3, "sourceJobName": "夹克 M 码",
     "sourceRollLabel": "A卷", "width": 1000, "fromY": 500, "length": 3500}
  ]
}
```

领用后的连带语义：

- 尾料卷是目标方案的**独立卷**：`rolls[].remnant=true`、初始 `cutLine=0`，与普通卷一样参与优化排样、手动/跨卷移动、必用卷约束及后续切线裁剪（在尾料卷上确认切线同样生成裁剪交接单）；
- 方案状态中的 `transfers[]` 给出本方案相关台账：`direction=inbound` 为领入（含 `targetRollId`），`outbound` 为领出；字段包含来源/目标方案与卷、原始区间起点 `fromY` 与长度，可随时追溯；
- 来源卷**封卷**：`rolls[].remnantFrozen=true`，对其确认切线、向其移动/排入裁片、把它设为必用卷一律 409/400；重新优化时封卷卷整卷作为障碍，不会有未裁件排入；改版前置可行性也排除封卷卷；
- 若来源方案存在**未排区**中以封卷卷为必用卷的未裁件，其必用卷约束随领用**自动释放**（否则该件永远无法排入），释放的件 ID 在 `releasedRequiredPieceIds` 返回；已裁件的卷号/坐标/必用卷永不变更；
- 来源方案被删除后，移交台账保留（`sourceJobId/sourceRollId` 置空、方案名与卷号定格保留），目标尾料卷与可追溯信息不受影响。

典型失败响应（均不产生任何部分变更）：

```text
404 目标方案不存在：没有 id=99 的方案
404 来源卷不存在：没有 rollId=99 的卷
409 尾料只能跨方案领用：来源卷与目标方案属于同一方案，已保留原状态
409 卷「C卷」（方案 #3 …）的尾料不可领用：切线 500mm 之后仍有 1 件未裁排入件（…），已保留双方原状态
409 目标方案已存在卷号「A卷·尾料(#1)」（同一方案内卷号必须唯一），请在请求体中指定其他 label
409 尾料领用冲突：该卷尾料已被另一请求领用（尾料只能跨方案领用一次），本次操作已整体回滚，来源方案与目标方案均无部分变更
```

### 改版纸样（按裁片型号修订）

车间收到改版纸样后，按**裁片型号**提交新轮廓、旋转许可与目标总件数；后续再次修订仍针对该型号的**当前纸样**，历史版次保留以便区分已裁件轮廓。

```bash
# 把型号 3（如「前片」）改为新轮廓、允许 180° 旋转、目标总件数 6
curl -s -X POST http://localhost:3000/api/jobs/1/piece-types/3/revisions \
  -H 'Content-Type: application/json' \
  -d '{
    "vertices": [[0,0],[640,0],[640,980],[0,980]],
    "quantity": 6,
    "allowRotate": true
  }'
```

请求体字段：

- `vertices`：新多边形轮廓（整数毫米顶点，规则同创建；自交/退化/非整数一律 400 拒绝）；
- `quantity`：目标**总件数**，1~200 的正整数；
- `allowRotate`：新纸样是否允许旋转 180°（缺省按 `false`）。

修订规则（任一校验不通过返回 400/409 并**保持原方案不变**）：

- **已裁件定格**：已裁件继续使用裁剪时那一版旧轮廓，卷号、卷内坐标、方向、必用卷与各卷切线/裁剪清单均不变；
- **未裁同型号件换新版**：外接尺寸、旋转许可改为新版；原必用卷约束（含按件单独设置的）逐件保留；
- **缩减**（`quantity` 减少）：先删未排件，再按 placement ID 降序删未锁定已排件；**已裁件与锁定件绝不删除**，因此目标件数小于「已裁数 + 未裁锁定数」时 400 拒绝；
- **扩增**：新增件进入未排区，无必用卷，件号（`seq`）接该型号现存最大号之后；
- **锁定件整票否决**：未裁锁定件必须在**原位**满足新轮廓与旋转许可（锁在 180° 而新版禁旋转即失败）、卷布边、切线后区域（`y ≥ cutLine`，边接触允许）、该卷瑕疵，并与已裁件/其他锁定保留件不重叠；任一不满足 → **整次修订 409 拒绝**，`conflicts` 逐件列出原因；
- **未锁定已排件按 ID 升序原位校验**（不分型号）：先通过的件成为后续件的障碍；失效者（越布边、进入已裁段、与瑕疵/已裁件/锁定件/先通过件内部重叠等）退回未排区，`reason` 注明「纸样改版（第 N 版）后原位失效：…」及冲突对象；
- **前置可行性**：只要还有未裁件，至少一卷的切线后剩余段必须容得下新外接尺寸；凡被未裁同型号件用作必用卷的卷，其切线后剩余段也必须容得下，否则 400 拒绝。

成功响应为完整方案状态，并额外附带本次修订摘要：

```json
{
  "revision": {
    "pieceTypeId": 3, "name": "前片", "revision": 2,
    "targetQuantity": 6, "previousQuantity": 4,
    "deletedPieceIds": [], "addedCount": 2,
    "bouncedPieceIds": [12], "cutPieceIdsKept": [1, 2]
  },
  "pieceTypes": [{ "id": 3, "currentRev": 2, "quantity": 6, "bw": 640, "bh": 980,
    "revisions": [
      {"id": 5, "rev": 1, "vertices": [[0,0],[620,0],...], "allowRotate": true,  "bw": 620, "bh": 950},
      {"id": 8, "rev": 2, "vertices": [[0,0],[640,0],...], "allowRotate": true,  "bw": 640, "bh": 980}
    ]}],
  "placements": [
    {"id": 1, "pieceTypeId": 3, "pieceRevisionId": 5, "revision": 1, "cut": true,  "bw": 620, "bh": 950, "...": "已裁件定格第 1 版"},
    {"id": 12, "pieceTypeId": 3, "pieceRevisionId": 8, "revision": 2, "cut": false,
     "placed": false, "reason": "纸样改版（第 2 版）后原位失效：与 卷「A」裁片「前片#4」 冲突"}
  ]
}
```

查询分辨要点：`pieceTypes[].revisions` 列出该型号全部版次，`pieceTypes[].vertices/currentRev` 为当前版；每件 `placements[]` 带 `revision`（版次号）与 `pieceRevisionId`，其 `bw/bh/allowRotate` 均取自该件**实际版次**——已裁件因此仍按旧轮廓参与显示、移动校验与优化。

典型失败响应：

```text
400 改版输入不合法，已保留原方案
    details: ["新轮廓：多边形轮廓自相交", ...]
400 目标总件数 2 小于该型号不可删除件数 3（已裁 2 件、未裁锁定 1 件均不可删除），已保留原方案
400 改版后新外接尺寸 700×400mm 超过必用卷「B窄」切线后剩余段（600×5000mm），必用卷约束不可能满足，已保留原方案
409 改版后 1 件锁定裁片无法在原位满足新纸样（锁定件须原位合法，否则整次拒绝），已保留原方案
    conflicts: ["裁片「前片#3」：新外接尺寸 500×400mm 超出卷「A」布边（原位 (600,0)，该卷 1000×5000mm）"]
```

### 兼容说明

- 旧客户端仍可用：创建用 `fabricWidth/fabricLength/defects`；`GET` 响应保留 `job.fabricWidth/fabricLength`（=首卷）与顶层 `defects`（=首卷瑕疵）；`placements[].x/y/rotation/placed/locked` 语义不变（坐标即其所在卷内坐标）。裁剪相关字段（`cuts`、`rolls[].cutLine/cutCount`、`placements[].cut`）为新增字段，旧客户端忽略即可。
- 旧 move 请求不带 `rollId`：单卷方案自动用唯一卷；多卷方案已排入件保持原卷，未排入件需显式给 `rollId`。裁剪确认同样：单卷方案 `POST /cuts` 可省略 `rollId`，多卷必须指定。
- 旧数据库首次启动时自动迁移：每个旧方案生成一卷「默认卷」，原瑕疵与裁片挂到该卷；并为 `rolls` 补 `cut_line=0`、为 `placements` 补 `cut=0`（旧方案默认尚未裁剪）。
- 改版纸样相关字段（`piece_revisions` 表、`placements.piece_revision_id/revision`、`piece_types.current_rev`）为新增：旧库首次启动时自动为每个型号补一条「第 1 版」纸样并把全部已存在件挂到该版，旧客户端只读 `pieceTypes[].vertices` 仍得到当前版轮廓。
- 裁剪交接单（`cut_batches`/`cut_batch_items` 表）为新增：旧库首次启动时自动建表，**不为升级前已裁件推造交接单**——这类件缺少逐次切线边界，在交接单查询接口与打印页中标识为「无批次历史」；此后新确认的切线正常生成真实交接单。`POST /cuts` 响应新增 `cut.batchId/batchSeq` 字段，旧客户端忽略即可。
- 尾料移交（`remnant_transfers` 表、`rolls.is_remnant/remnant_transfer_id/remnant_frozen` 列）为新增：旧库首次启动时自动建表补列，既有卷默认 `is_remnant=0、remnant_frozen=0`，不影响任何旧行为；方案详情新增 `rolls[].remnant/remnantFrozen/remnantTransferId` 与顶层 `transfers[]`，旧客户端忽略即可。

## 规则与算法说明

- 坐标与尺寸一律为**整数毫米**；旋转仅支持 0°/180°（旋转不改变外接矩形尺寸）。
- 每卷独立 1mm 占用栅格：栅格判定保守（宁可留缝也不重叠），结果**保证**卷内无内部重叠、不压该卷瑕疵、不出该卷布边；斜边附近约 1mm 空隙属正常余量。
- 手动移动使用精确几何判定，**边界接触（共点/共边）完全允许**；跨卷只校验目标卷。
- 多卷选择：每件在所有（必用约束允许的）卷的可行候选位置中，按全局元组 `[启用卷数, 总占用长度, -接触周长, x, 卷序号, 角度]` 取最优；必用卷件优先排入以提前打开其必用卷；压实时允许跨卷迁移从而腾空整卷。
- 裁剪进度：切线只增不减；切线前布段在优化器中作为该卷的全幅障碍矩形参与排样，已裁件视同锁定件写入原卷原位，因此未裁件天然不会进入已裁段。
- 尾料移交：领用时在目标方案新建一卷（`is_remnant=1`，长度=来源卷剩余长度、起点为零），把尾料区间内的瑕疵按 `y - cutLine` 平移；跨越起点的瑕疵取与 `[cutLine, length)` 的矩形交集（沿切线裁截）。登记/领用同一事务：台账 `UNIQUE(source_roll_id)` 加事务内重校验与封卷乐观锁（`UPDATE … WHERE remnant_frozen=0`）保证重复/并发领用必有一方失败回滚，两方案均无部分变更；来源卷置 `remnant_frozen=1` 后在移动/切线/必用卷/改版/优化各入口被拒或整卷视为障碍；未排区中以封卷卷为必用卷的未裁件在事务内释放约束。删除来源方案只把台账来源字段置空，台账与目标卷保留。
- 裁剪交接单：确认切线时与裁剪进度同一事务写入 `cut_batches`（单头：前后切线、卷、件数）与 `cut_batch_items`（明细快照：件号/版次/轮廓/坐标/方向）；`UNIQUE(roll_id, seq)` 加事务内重校验保证同卷并发确认不产生重复或倒序记录。交接单只增不改，改版与重排样不回写；升级前已裁件无批次记录，查询时动态识别为「无批次历史」。
- 改版纸样：每个型号保留全部版次（`piece_revisions`），每件通过 `piece_revision_id` 指向其实际版次；已裁件定格旧版、未裁件随改版迁移到新版。修订的原位校验与手动移动同一套精确几何（边界接触允许）：锁定件只与不可移动参照（布边/切线/瑕疵/已裁件/锁定件）核对，任一失败整次拒绝；未锁定已排件不分型号按 placement id 升序逐个原位定夺，失效即退回未排区。
- 规模上限（可在 `src/validate.js` 调整）：每方案 ≤ 50 卷，单卷布幅 ≤ 5000mm、长度 ≤ 100000mm，单卷面积 ≤ 1.5 亿 mm²，裁片总数 ≤ 1000 件，单型号顶点 ≤ 200 个。

## 项目结构

```
src/geom.js      精确几何：轮廓校验、内部重叠判定（边界接触允许）
src/nest.js      排样优化器：栅格掩码、左下放置、optimizeRolls 多卷压实；optimize 为单卷兼容封装
src/validate.js  创建输入校验与改版输入校验（多卷/旧单卷、必用卷，逐项指明问题对象）
src/db.js        SQLite 模式、连接与旧库自动迁移（rolls 表、多卷字段、cut_line/cut 裁剪列、piece_revisions 版次表、cut_batches/cut_batch_items 交接单表、remnant_transfers 尾料台账与 rolls 封卷/尾料列）
src/server.js    Express 路由（多卷状态、跨卷 move、require-roll、裁剪确认/进度、裁剪交接单查询、按型号改版纸样、尾料总览/跨方案领用等）
public/          单页前端（卷标签、卷卡片、画布拖拽、跨卷面板、裁剪进度条、交接单面板、尾料移交面板、改版纸样面板与按件版次绘制）
                 + batch.html/batch.js 裁剪交接单打印页（轮廓缩略图、签字栏、打印样式）
test/run.js      78 项几何/排样/校验/HTTP API/裁剪进度/裁剪交接单/改版纸样/尾料移交测试
```
