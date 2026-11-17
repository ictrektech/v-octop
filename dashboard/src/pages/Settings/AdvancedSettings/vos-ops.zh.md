### 使用 VOS 运维

打开 **管理 → 应用设置 → VOS 运维**，点击 **授权诊断**。VOS 超级管理员可查看已安装应用、工作流状态、应用容器、近期日志、诊断摘要、Docker 发布端口和镜像。需要让专家使用只读工具 `vos_diagnostics` 时，授权前勾选 **本次授权允许我的专家读取诊断信息**。在运维页点击 **结束诊断** 或退出 v-Octop 可结束授权。每次最长 15 分钟。

重启、停止或清理前，先核对预览，再输入完整目标 ID。预览 60 秒内单次有效。重启针对已安装应用。停止针对已安装或已停止应用的旧版容器，且容器正在运行或重启。符合条件的 `created` 或 `exited` 旧容器可删除，可写层随之删除，卷保留。镜像须无容器引用、无标签且无仓库摘要。v-Octop 自身的应用和容器受保护。

### API

使用当前 VOS 同源地址，基路径为 `/app/com.ictrek.v-octop/__va/vos-ops`。携带浏览器登录 Cookie 和 `X-VA-Ops: 1`。跨源浏览器请求会被拒绝。JSON POST 请求使用 `Content-Type: application/json`。从 `authorize` 获取授权后，其余请求用 `X-VA-Ops-Grant` 传入。授权绑定浏览器会话。网关每次检查当前 VOS 令牌的 `is_super_admin`。响应为 JSON，禁用缓存。

| 方法和路径        | 输入                                                                                                                                                         | 成功响应（HTTP 200）                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST `/authorize` | 必填 JSON 布尔值 `expert`。仅浏览器诊断时传 `false`。                                                                                                        | `grant` 为不透明字符串，`expiresIn` 为剩余秒数，最大 900。再次授权会替换当前会话的授权。                                                                                                 |
| POST `/close`     | 空对象 `{}`。                                                                                                                                                | `{ "closed": true }`。关闭本授权的浏览器与专家访问。                                                                                                                                     |
| GET `/inventory`  | 无。                                                                                                                                                         | 数组 `apps`、`containers`、`publishedPorts`、`unusedImages`、`unreferencedTaggedImages`。                                                                                                |
| GET `/status`     | 必填查询字符串 `id`，应用 ID。                                                                                                                               | `appId`、`version`、`state`、`lastError`、`workflow`。无工作流时 `workflow` 为 null，否则含 `taskId`、`status`、可为 null 的 `stage` 和 `failure`。应用和工作流状态由当前 VOS 版本提供。 |
| GET `/logs`       | 必填查询字符串 `id`，完整 64 位小写十六进制容器 ID。可使用下文日志过滤字段。                                                                                 | `id` 与通用日志响应。                                                                                                                                                                    |
| GET `/app-logs`   | 必填查询字符串 `appId`。可使用下文日志过滤字段。                                                                                                             | `appId`、`containers`（来源名称）和通用日志响应。按时间合并记录。                                                                                                                        |
| GET `/diagnose`   | 必填查询字符串 `id`，完整容器 ID。                                                                                                                           | `id`、`name`、`image`、`stack`（appId、version、project）、`state`、`logs`。诊断字段见下文。                                                                                             |
| POST `/preview`   | 必填 JSON 字符串 `action`、`id`。`restart` 用应用 ID，`stop-container`、`remove-container` 用完整容器 ID，`remove-image` 用 `sha256:` 加 64 位小写十六进制。 | `action`、`targetId`、`target`（当前快照）、不透明 `confirmation`、`expiresIn: 60`。新预览替换本授权的旧预览。                                                                           |
| POST `/execute`   | 必填 JSON 字符串 `confirmation`、`targetId`，须与预览完全匹配。                                                                                              | `action`、`id`、`taskId`。重启受理时返回 VOS 任务 ID，其余操作为 null。网关重新核对目标并消耗确认口令。重试前先查询当前状态。                                                            |

应用 ID 长度为 1–128，可用字母、数字、点、下划线和连字符，首字符须为字母或数字。接口只接受已声明的操作与参数。各列表允许为空。

**清单。** 应用条目含 `appId`、`installationId`、`version`、`state`、`lastError`（无错误时为空字符串）、布尔值 `restartable`。容器条目含 `id`、`name`、`image`、`imageId`、`state`、`status`、`stack`、`ports`，以及表示操作资格的布尔值 `stoppable`、`cleanup`。每条端口含数值 `hostPort`、`containerPort`，字符串 `protocol`、`address`。已发布端口清单另含 `container` 和可为 null 的 `appId`。镜像条目含 `id`、`bytes`。无标签未使用镜像另有 `created`（Unix 秒）。带标签且无容器引用的镜像另含字符串数组 `tags`、`digests`。

**日志。** 默认读取最后 150 条。可选 `since`、`until` 接受 RFC 3339 或相对当前时间的正数时长，支持 `ms`、`s`、`m`、`h`、`d`。`after` 使用上次响应的 UTC `next` 时间戳作为排他游标，与 `since` 二选一。`pattern` 为 1–200 字符的文本匹配，忽略大小写。`context` 为 0–50 的整数，默认 0。使用时间边界或文本条件时最多扫描 1,000 条。返回 `text`、`scanned`、`returned`、`truncated`，以及可为 null 的 `first`、`last`、`next` 时间戳。最多返回 300 条。日志密集时缩小时间范围。

**诊断。** `state` 含 `status`，布尔值 `running`、`restarting`、`oomKilled`，可为 null 的 `exitCode`、`startedAt`、`finishedAt`，以及 `error`、`restartCount`。无健康检查时 `health` 为 null，否则含 `status`、`failingStreak` 和最多三条 `recent`，每条含 `start`、`end`、`exitCode`、`output`。`logs` 含 `scanned`、可为 null 的 `first`、`last`，以及最多 40 条错误摘要 `errors`。每条包含 `sample`、`count` 和可为 null 的 `first`、`last`。

**错误。** JSON 错误为 `{ "error": "code" }`。HTTP 400 包括无效请求体（`invalid-body`）、无效目标（`invalid-target`、`app-id-required`）、日志过滤字段错误（`invalid-since`、`invalid-until`、`invalid-after`、`invalid-pattern`、`invalid-context`）或目标 ID 不匹配（`confirmation-mismatch`）。HTTP 401 `sign-in-required` 需重新登录。HTTP 403 `forbidden` 表示权限、授权或请求来源不符合要求。HTTP 404 `not-found` 表示路由或目标不可用。HTTP 409 `target-changed` 表示目标或预览已变化，刷新后再预览。HTTP 429 `too-many-grants` 表示授权数量达到上限。HTTP 502 包含 `docker-unavailable`、`vos-request-failed`、`response-too-large`、`upstream-unavailable`，请检查 VOS 或 Docker，必要时缩短日志范围。

**专家工具。** `vos_diagnostics` 的 `query` 取值为 `inventory`、`status`、`logs`、`app-logs`、`diagnose`。除 `inventory` 外传入上文定义的 `id`。返回对应读取操作的 `status` 和 `body`。HTTP 503 `diagnostics-unavailable` 表示当前缺少 VOS 能力。写操作须由管理员在浏览器预览并确认。
