# 养老机构评估 → 管理复核 → 家属告知 → 费用生效（服务端流程演示）

NestJS + PostgreSQL + TypeORM + decimal.js 的服务端流程。**无前端**。

> ⚠️ 本项目使用**虚构量表 DEMO_ADL**，仅用于行政流程（评估、复核、告知、计费）演示，
> **不构成医疗诊断、护理分级依据或真实护理建议**。该声明同时固化在量表版本与每条家属告知文本中。

## 流程规则（对应业务要求）

1. **必填项缺失不得自动定级**：任一评估员必填条目缺失/无效/误用 NA，案件为 `INCOMPLETE`，无确认等级，不能复核、不能费用生效。
2. **不适用项（NA）如何影响分母由量表定义**：`scale_versions.na_policy` 决定。演示量表为 `EXCLUDE_FROM_DENOMINATOR`，且仅 `STAIRS`、`OUTDOOR` 两题允许 NA；对不允许 NA 的题选 NA 视为无效作答。
3. **两位评估员结果冲突进入复核，不能简单取较高等级**：等级不一致 → `PENDING_REVIEW`；管理员必须在**两位评估员候选等级之内**显式选择并填写意见。取候选外等级（如“折中”）返回 400。
4. **等级确认后生成告知记录**：一致由系统确认（reviewer=`SYSTEM`），冲突由管理员确认；确认即生成一条 `PENDING / CONFIRMED` 告知。
5. **送达失败与尚未确认分别记录**：
   - 送达结果 `status`：`PENDING / DELIVERED / FAILED / SIGNED`（SIGNED 为签收闭环完成）；
   - 可告知状态 `notifiableStatus`：`CONFIRMED / UNCONFIRMED`。尚未确认时也可尝试告知，落 `UNCONFIRMED + FAILED（等级尚未确认）`。
6. **费用生效按机构示例规则独立判断**：等级是否已确认才是生效前提，与家属告知是否送达/签收无关——**“已发送”不等于“已确认”**。
7. **可靠回执与签收闭环**（离线模拟多渠道投递器，不连接真实短信/外部服务）：
   - 每次投递保存**不可变内容快照**、**稳定投递号**（`DN-000001…`）与**尝试序号**；
   - 投递器异步回传受理/送达/失败/签收事件；回执按 `eventId` 幂等，可重复、乱序、迟到；
   - 单次尝试状态机 `PENDING → ACCEPTED → DELIVERED / FAILED`，**终态粘滞**：迟到/重复回执仅留痕；
   - 告知级状态只由**最新一次尝试**投影：旧尝试的送达/失败不得覆盖新尝试的最终状态；
   - 家属签收只能绑定**已送达尝试的明确内容版本**；内容被新版本替代后，旧版迟到签收以 `SUPERSEDED` 留痕、不生效；
   - 失败可按策略重试（仅最新失败尝试），新尝试使用新投递号并重新快照当前内容版本；
   - 回执归并、投递、签收全部在数据库事务内完成，批次失败整批回滚。
8. **同一天不能出现重叠生效等级**：服务层显式校验 + PostgreSQL `btree_gist` 的 daterange 排他约束双保险。月中换级时旧期间自动截至生效日前一日（半开区间首尾相接）。
9. **费用按天分段**：等级期间 × 日费版本切换日二次切分，闭区间逐天连续（含无生效等级空洞段），天数守恒校验；金额一律 decimal.js 计算，两位小数 `ROUND_HALF_UP`。
10. **接口可解释**：评估响应内嵌两位评估员逐项明细（原始选项、分值、是否计入分母、NA 说明、原始分/有效分母/百分比/定级阈值）；费用分段逐段给出等级、日费版本、天数、金额与来源；告知时间线逐事件给出投递、回执（含未生效留痕）与签收。

## 演示数据

- 量表 `DEMO_ADL v1.0.0`：10 题（8 必填 + STAIRS/OUTDOOR 可 NA），0~3 分制；
  百分比阈值 `<40% LIGHT / [40%,70%) MODERATE / >=70% SEVERE`。
- 示例日费（元/天）：LIGHT 100；MODERATE 180（2024-01-01 起 200）；SEVERE 260（2024-01-01 起 300）。

## 运行

无需系统 PostgreSQL / root：默认在项目内启动**用户态嵌入式 PostgreSQL 18**（`embedded-postgres`）。
如有外部 PG，在 `.env` 设置 `DB_HOST` 即切换为外部连接（见 `.env.example`）。

```bash
npm install
npm run seed          # 可选：仅建表+种子
npm run start         # http://127.0.0.1:3000/api
npm test              # e2e（自带嵌入式 PG，覆盖下列全部场景）
```

## API（均在 /api 前缀下）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/scales/:id` | 量表版本、原始条目/选项、NA 分母策略、定级阈值 |
| POST | `/assessments` | 提交两位评估员作答 → INCOMPLETE / CONFIRMED / PENDING_REVIEW |
| GET | `/assessments/:id` | 案件 + 逐项评分来源 + 复核意见 + 告知记录 |
| POST | `/assessments/:id/review/confirm` | 管理复核（等级限候选内，支持 `idempotencyKey`） |
| POST | `/assessments/:id/notification/attempt` | 家属告知尝试（旧同步接口，`{"simulateFail":true}` 模拟通道失败） |
| GET | `/assessments/:id/notification` | 全部告知记录（失败历史、未确认尝试均保留；状态含闭环投影） |
| POST | `/assessments/:id/notification/deliveries` | 发起投递（不可变快照 + 稳定投递号 + 尝试序号，支持幂等键） |
| GET | `/assessments/:id/notification/deliveries` | 该案件全部投递尝试 |
| GET | `/assessments/:id/notification/timeline` | 时间线：创建/版本/投递/回执（含留痕）/签收 |
| POST | `/assessments/:id/notification/:notificationId/refresh` | 内容刷新：内容变化时版本 +1，旧版本登记留痕 |
| GET | `/notification/deliveries/:deliveryNo` | 完整证据链：投递快照 + 全部回执 + 签收 |
| POST | `/notification/deliveries/:deliveryNo/retry` | 失败重试（仅最新失败尝试；新投递号、新尝试序号） |
| POST | `/notification/deliveries/:deliveryNo/sign` | 家属签收（仅已送达可签；重复签收幂等回放；旧版签收仅留痕） |
| POST | `/notification/receipts` | 投递器回执归并 `{"receipts":[{eventId,deliveryNo,type,...}]}`（整批单事务） |
| POST | `/fees/activate` | 等级生效 `{caseId, effectiveDate}` |
| GET | `/fees/segments?elderId=&from=&to=` | 按天分段费用与 decimal 合计 |
| GET | `/openapi.json` | OpenAPI 3.0 描述（仓库根目录 `openapi.yaml` 为其镜像） |

### 示例：投递 → 回执 → 签收闭环

```bash
# 1) 确认案件后发起投递（取该案件最新告知记录）
curl -sXPOST localhost:3000/api/assessments/<case-uuid>/notification/deliveries \
  -H 'Content-Type: application/json' -d '{"channel":"SMS"}'
# → {"delivery":{"deliveryNo":"DN-000001","attemptNo":1,"contentVersion":1,"contentSnapshot":"...",...}}

# 2) 离线模拟投递器异步回传受理/送达（回执可重复、乱序、迟到，按 eventId 幂等）
curl -sXPOST localhost:3000/api/notification/receipts -H 'Content-Type: application/json' -d '{
  "receipts":[
    {"eventId":"EV-1","deliveryNo":"DN-000001","type":"ACCEPTED"},
    {"eventId":"EV-2","deliveryNo":"DN-000001","type":"DELIVERED"}
  ]}'

# 3) 家属签收（绑定已送达的内容版本 v1）
curl -sXPOST localhost:3000/api/notification/deliveries/DN-000001/sign \
  -H 'Content-Type: application/json' -d '{"signer":"家属甲","eventId":"EV-3"}'
# → 告知记录状态 SIGNED；GET /notification/deliveries/DN-000001 查看完整证据链
```

### 示例：月中升级 + 闰月

```bash
# 1) 轻度确认并 2024-01-01 生效（两位评估员全选独立完成）
curl -sXPOST localhost:3000/api/assessments -H 'Content-Type: application/json' -d '{
  "elderId":"E1","elderName":"张某","familyContact":"13900000000",
  "assessors":[{"assessorId":1,"answers":[{"itemCode":"TRANSFER","optionCode":"INDEPENDENT"}]},
               {"assessorId":2,"answers":[{"itemCode":"TRANSFER","optionCode":"INDEPENDENT"}]}]}'
# 全部 10 题均提交；冲突案件再 POST /review/confirm；然后：
curl -sXPOST localhost:3000/api/fees/activate -H 'Content-Type: application/json' \
  -d '{"caseId":"<case-uuid>","effectiveDate":"2024-02-15"}'
curl -s 'localhost:3000/api/fees/segments?elderId=E1&from=2024-02-01&to=2024-02-29'
# 2024 为闰年：2/1~2/14 与 2/15~2/29 两段，共 29 天
```

## e2e 覆盖场景

- 必填缺失 / 无效 NA → INCOMPLETE，不定级、不可复核生效；
- NA 从分母剔除（8 题 TOTAL_DEP + 2 NA → 分母 8 而非 10）及逐项解释；
- LIGHT vs SEVERE 冲突 → 复核候选外等级 400、显式选较低 LIGHT 成功（证明不取高）；
- 重复确认请求：相同幂等键回放、无键重复 409；
- 尚未确认尝试告知 → `UNCONFIRMED/FAILED`；送达失败原因分行留痕；
- 月中升级切旧区间、同案重复生效回放、同日不同等级重叠 409；
- 闰月 2024-02（29 天）分段金额、跨 2024-01-01 调价日同等级二次分段、无等级空洞段、非法闰日期拒绝。

### 回执-签收闭环（test/notification-closure.e2e-spec.ts）

- 首次送达后签收形成完整证据链（快照/投递号/回执/签收/时间线）；
- 失败重试成功后，旧失败迟到不回滚状态；旧尝试送达不得覆盖新尝试最终状态；
- 重复送达与重复签收不新增结果（eventId 幂等 + 终态粘滞 + 单签收约束）；
- 乱序回执：送达先于受理到达，受理后至仅留痕；
- 内容被新版本替代后，旧版迟到签收仅留痕（SUPERSEDED），新版本重新投递签收后闭环；
- 签收只能绑定已送达投递（未送达 409）；仅最新失败尝试可重试；
- 回执批次事务失败整批回滚，投递尝试与有效回执无部分写入；
- 未确认案件：已发送不等于已确认，费用生效仍按机构规则独立判断；
- 重启后投递尝试、有效回执、签收与等级费用状态保持一致；
- OpenAPI 描述可用且覆盖全部接口。

### 数据库迁移（test/migration.e2e-spec.ts）

- 既有旧库增量迁移：新表/新列/序列齐备，历史告知数据保留且默认版本 v1；
- 迁移幂等可重放。
