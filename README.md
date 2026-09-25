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
   - 送达结果 `status`：`PENDING / ACCEPTED / DELIVERED / FAILED`（失败原因独立留痕，每次尝试一行）；
   - `ACCEPTED` 仅表示离线投递器“已受理/已发送”，**不构成送达确认**，不能当作“已确认”；
   - 可告知状态 `notifiableStatus`：`CONFIRMED / UNCONFIRMED`。尚未确认时也可尝试告知，落 `UNCONFIRMED + FAILED（等级尚未确认）`。
6. **费用生效按机构示例规则独立判断**：等级是否已确认才是生效前提，与家属告知是否送达/签收无关。
7. **同一天不能出现重叠生效等级**：服务层显式校验 + PostgreSQL `btree_gist` 的 daterange 排他约束双保险。月中换级时旧期间自动截至生效日前一日（半开区间首尾相接）。
8. **费用按天分段**：等级期间 × 日费版本切换日二次切分，闭区间逐天连续（含无生效等级空洞段），天数守恒校验；金额一律 decimal.js 计算，两位小数 `ROUND_HALF_UP`。
9. **接口可解释**：评估响应内嵌两位评估员逐项明细（原始选项、分值、是否计入分母、NA 说明、原始分/有效分母/百分比/定级阈值）；费用分段逐段给出等级、日费版本、天数、金额与来源。
10. **可靠回执与签收闭环（离线模拟投递器，不连接真实短信/外部服务）**：
    - 每次投递保存**不可变内容快照**（含 SHA-256 哈希）、**稳定投递号**（`DLV-xxxx`，同号全部尝试即重试）与**尝试序号**（同号内从 1 递增）；
    - 回执只追加（`receiptEventId` 天然去重），允许**重复、乱序、重试后迟到**；归并状态机每次从全部尝试重算：仅“最高尝试序号的终态（送达/失败）”决定最终状态，**旧尝试的迟到送达不覆盖新尝试的最终状态**，已送达不会被迟到失败回滚；
    - **家属签收只能绑定“已送达”且“内容版本仍为当前”的投递**（每投递至多一条 `BOUND`，DB 部分唯一索引兜底）；告知内容被新版本替代后，旧版本迟到签收仅 `STALE_TRACE` 留痕；
    - 早到（先于送达）的 SIGNED 回执持久化并排队，待对应尝试送达后自动闭环；未送达时接口给 409 且回执不丢；
    - 全部过程通过时间线 API 给出 `版本创建 → 投递尝试 → 回执 → 签收` 证据链。

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
| POST | `/assessments/:id/notification/attempt` | 发起家属告知投递（`{"asyncMode":true,"channel":"WECHAT"}` 仅受理；默认同步给出确定结果；未确认案件落 UNCONFIRMED/FAILED） |
| POST | `/assessments/:id/notification/deliveries/:no/retry` | 失败重试：同稳定投递号、尝试序号 +1、内容快照不变（已送达拒绝重试） |
| POST | `/assessments/:id/notification/receipts` | 离线投递器回执回调（ACCEPTED/DELIVERED/FAILED/SIGNED，按事件号幂等、乱序归并） |
| POST | `/assessments/:id/notification/signoffs` | 家属显式签收（仅绑定已送达的当前内容版本；重复签收回放） |
| POST | `/assessments/:id/notification/renotify` | 重新告知：生成新内容版本并替代旧版本（旧版迟到签收只留痕） |
| GET | `/assessments/:id/notification/deliveries/:no` | 单投递证据链：聚合状态、每次尝试、全部回执、签收 |
| GET | `/assessments/:id/notification/timeline` | 告知/投递/回执/签收统一时间线 |
| GET | `/assessments/:id/notification` | 全部告知记录（历史兼容：锚点 + 每次尝试的扁平列表） |
| GET | `/docs` `/docs/openapi.json` | OpenAPI（Swagger UI 与 JSON，均在 `/api` 前缀下） |
| POST | `/fees/activate` | 等级生效 `{caseId, effectiveDate}` |
| GET | `/fees/segments?elderId=&from=&to=` | 按天分段费用与 decimal 合计 |

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
- 闰月 2024-02（29 天）分段金额、跨 2024-01-01 调价日同等级二次分段、无等级空洞段、非法闰日期拒绝；
- **回执/签收闭环**：首次送达→签收完整证据链；失败重试成功后旧失败/旧送达迟到不回滚；乱序（新尝试先失败、旧尝试后送达）以最高序号终态为准；重复送达/重复签收不新增；并发签收 DB 部分唯一索引兜底；
- **内容版本替代**：新版本送达签收正常，旧版本迟到签收仅 `STALE_TRACE`，早到签收在版本替代后永久留痕；
- **持久化一致性**：重启后投递/聚合/回执/签收状态恢复；事务失败时早到签收回执仍留痕；送达签收状态与等级费用完全独立；
- **数据库迁移**：旧版扁平告知表升级（补表/补列/回填 ANCHOR/部分唯一索引）且重复迁移幂等。
