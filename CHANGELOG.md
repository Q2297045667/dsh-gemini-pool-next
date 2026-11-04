# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## Unreleased — 2026-11-04

### Changed
- 项目统一更名为 `dsh-gemini-pool-next`，同步 npm 包名、仓库链接、安装命令、Cordis 注册、客户端模块与测试；Antigravity 服务标识和现有账号存储路径保持兼容
- **模型目录与运行时实体改由账号实际通告的实体驱动**：`parseCatalogModels` 的归属判定从「宽松家族正则」改为结构化匹配（同 base、`-low/-medium/-high` 级别实体、`-tiered` 实体、`-thinking` 实体、`别名`、`名称 (等级)` 标签），不再出现 `gemini-3.5-flash-lite` 被算成 `gemini-3.5-flash`、`gemini-3.1-flash-lite` 被算成 `gemini-2.5-flash` 的串行；新增后端真实通告的 Gemini 3.5 / 3.1 / 2.5 Flash Lite 三个条目

### Fixed
- **客户端指纹（User-Agent）被后端按版本门控，Gemini 4 Argon「看起来不存在」——三个报错的共同根因**：`fetchAvailableModels` 对旧版/格式不符的客户端只回一份缩水的目录。同一 Pro 账号实测：旧指纹 `antigravity/1.15.8 linux/amd64` 只返回 16 个实体（无 Gemini 4 Argon、无分级 3.8），改用当前指纹 `antigravity/hub/2.24.0 (aidev_client; os_type=…; arch=…; cl=1000335682)` 返回 22 个实体并含 `gemini-4-argon-low/medium/high`。现默认发送当前 hub 指纹（`ANTIGRAVITY_USER_AGENT` 仍可覆盖），并把指纹写入模型设置：插件升级抬高指纹后，启动会在后台自动重新发现目录，不必手动刷新额度
- **「No account in the current pool selection supports model "gemini-4-argon"」**：指纹修正后旗舰正常通告；同时保留兜底——目录刷新会把池内没有任何账号通告的模型从已勾选集合里摘掉（设置页只留可服务条目），已保存会话若仍指向这类模型，`resolveModelRoute` 会挑选池内同族最合适的可用模型（Gemini / Claude / 生图线各自独立，GPT-OSS 不跨族）并在日志说明替换，不再直接抛错
- **`Antigravity API error (404 ... runtimeModel=gemini-3.7-flash-low/-high ... Requested entity was not found`)**：运行时实体解析改为以该账号 `fetchAvailableModels` 的真实实体集为准——先按请求等级找 `-low/-medium/-high` 实体，再找 `-tiered` 实体，再找裸 id，最后才在同族里挑下一个可用模型；删除指向不存在实体的旧回退链（3.8→3.7→3.6）与整段正则匹配旧路径，并移除后端从未通告的 Gemini 3.7 / 3.6 两代条目，请求不会再带上后端从未通告的 id
- **「让模型思考等级支持更多等级」**：目录里的可选等级改为按账号真实实体计算——Gemini 4 Argon 与 Claude Opus/Sonnet 5.5 均为 Low / Medium / High（各自对应 `*-low/medium/high` 实体），Gemini 3.8 Flash 为 Minimal / Low / Medium / High（另有 tiered 实体兜底）；per-level 实体不再附带 `thinkingConfig`（等级已由实体 id 表达，可避免 Argon 对多余思考参数敏感），仅 tiered 实体经 thinkingConfig 表达等级，且被后端拒绝时先降一档重试
- **`Antigravity API error (400 ... "messages: text content blocks must contain non-whitespace text")`**：请求侧不再下发空白文本块。用沙盒端点复现确认：**模型侧只含空白的 text block** 会触发这条 400（`{role:"model",parts:[{text:" "}]}` → 400；换成 user 轮则通过），空字符串 text 会报 `messages.N.content.N.text.text: Field required`，而只含空白的工具输出其实被 shim 转成 JSON 文本、不会触发。现在：任何轮次里只含空白的 text part 都被丢弃（丢弃后变空的整轮一并省略，并保证对话以 user 轮开头与结尾）；工具结果为空或只有空白时写 `(no output)`（出错写 `Tool failed`）；`system` 只有空白时也不下发 systemInstruction 段
- **`Antigravity API error (400 ... "Function call is missing a thought_signature in functionCall parts ... function call `default_api:run_code`, position 140")`**：Gemini 3.x/4.x 拒绝回放一个没有有效 `thought_signature` 的 `functionCall`——而这条签名只有「产出它的那个运行时实体」才有，别的模型（deepseek / claude / 别的 gemini 实体）生成的工具调用在回放时必然没有。上下文压缩/切模型把整段历史重发时就会撞上。修复：对 Gemini 3.x/4.x 目标，凡不是「同一个请求模型 + 同一个运行时实体 + 首条签名有效」的工具调用，连同其结果一起降级成纯文本 `[Observation from \`name\` (args): …]`，保留信息且不再触发 400；Gemini 2.x 与 Claude/GPT 仍走原生 functionCall。沙盒端点实测：旧形状（无签名 functionCall）→ 400，新形状（文本 Observation）→ 200
- **`Antigravity API error (400 ... "`tool_use` ids were found without `tool_result` blocks immediately after")`**：DSH 把工具结果作为独立的 `role:"tool"` 消息下发（call id 在 `toolCallId` / `source.callId` 上），而旧转换只认识「塞在 user 消息里的 `tool-result` 块」，工具结果因此被当成普通用户文本发出去——Claude 后端看到 tool_use 后面没有 tool_result，直接 400，并且这条历史之后任何一次 Claude 请求（包括上下文压缩和切模型）都会失败。现在 `role:"tool"` 消息转成 `functionResponse`，落在对应 tool_use 的**紧接着的下一轮**（结果若排在别的用户消息之后会被前插到正确位置）；历史以未完成的工具调用结尾时补占位结果而不是只补一句 `Continue`
- 模型替换后仍以「请求时选中的模型 id」写入回放元数据，避免宿主按请求 id 校验时丢弃整轮 thought signature
- 账号池首次初始化合并并发加载，额度刷新统一串行落盘，避免账号丢失与临时文件重命名冲突；自动调度识别真实额度结构并按所有窗口的最小余量排序，主备候选不重复，手动模式严格锁定所选账号
- 模型目录合并整个账号池，保留用户明确保存的空选择和下架元数据；首次发现只启用可用模型，Claude 4.6 不再误匹配 5.5；文本、生图与视觉调用跳过已知不支持目标模型的账号
- 三条生成路径共享 SSE 解析与 reader 清理，兼容分块 UTF-8、无空格 `data:` 和无末尾换行的帧；结构化限流错误正确触发冷却与切号，生图返回后取消剩余流；历史图片超限时完整省略旧图并保留最新图片
- 视觉桥路由与日志异常保持透传；本地图片和生图输出校验真实路径并拒绝符号链接越界，URL 地址检查覆盖 IPv4-mapped IPv6；生图按返回 MIME 保存正确扩展名，URL 与 inline 图的重看提示不再承诺无效附件哈希
- 设置页不再把普通看图模型标为生图模型，保存失败不再显示成功；额度命令兼容真实 `displayName/buckets/window` 结构，冷却错误在日志、存储和状态输出中脱敏；Web API 对非法 JSON 和超大请求体分别返回 400 / 413
- OAuth 登录复用 token 交换逻辑，支持等待回调时取消，并发网页登录共享回调服务器，拒绝缺少有效 token 的成功响应，缺少浏览器启动器时不再崩溃；后台探活逐轮调度并随插件卸载清理

### 验证
- `npm run check` 与带覆盖率的全量测试均为 222/222；语法检查覆盖全部发布模块，新增回归包括请求里不出现空白文本块（空白用户轮、空白文本块、只输出空格的工具结果）、工具调用与结果严格相邻（role:"tool" 结果、未完成调用补占位、混合历史不变量）、Gemini 3.x/4.x 目标对跨提供方工具调用的签名降级、客户端指纹格式与目录门控、真实后端实体目录下的运行时实体解析（含 tiered 实体、按等级实体、裸实体三种形态）、不可用模型降级（含跨族降级与生图线绝不落到文本模型）、思考等级目录计算、已勾选集合剪枝、替换场景下的回放元数据、OAuth 本地回调、真实临时存储、模型级账号选择、Web API、CLI 及插件装卸生命周期
- npm 包清单核对、解包导入和隔离 harness home 下的 CLI 冒烟检查通过；没有升级依赖或更改版本号
- 使用模拟 Google 响应与临时凭证验证，未进行真实 Google 登录、线上模型调用或完整 DSH GUI 端到端验证；URL DNS 预检查与宿主 fetch 独立解析，不承诺防止 DNS 重绑定

## v0.9.0 — 2026-11-03

### Added
- **模型可用性如实反映账号实际持有实体（Refs #16）**：改版后 4 Argon 为 Pro 专属、Claude 5.5 为 Pro 非试用专属。目录合并不再给「后端 `available=` 里没有对应实体」的模型塞回退额度——缺失实体标记为不可用（设置页显示「账号不可用」徽标、无额度），首次登录也只启用账号真实通告的模型
- **接入改版后 Antigravity 的 Pro 会员新模型**：模型目录对齐官方 Choose a model 页（[antigravity.google/docs/models](https://antigravity.google/docs/models/)）。新增 **Gemini 4 Argon**（Pro 旗舰，后端实体 `gemini-4-argon-high`，思考等级 High、上下文 1M、输出 65536）、**Claude Opus 5.5** 与 **Claude Sonnet 5.5**（Pro 非试用，后端实体 `claude-opus-5-5-high` / `claude-sonnet-5-5-high`）；Gemini 3.8 Flash 保留（新版目录中全档位可用）。ROUTING / 运行时输出上限 / 动态匹配 / 设置页可用性探针（`publicModelMatchNeedles`）全部按后端实际通告的实体名更新
- 设置页模型选择器新增「⚠️ 将下架」徽标：Claude Opus/Sonnet 4.6 将于 2026-11-18 被 Antigravity 移除，条目保留但标记 deprecated 与下架日期

### Changed
- **迁移到最新改版的 DSH（0.2.x）**：`engines.dsh` 收紧为 `>=0.2.0 <0.3.0`，devDeps 对齐 0.2.2-alpha.3（cordis ~4.0.6-alpha.2、schemastery ^3.18.5）。移除对旧 `offloadRequestImagesWithPolicy` 的运行时探测（0.2.x 已删除该 API），改为插件自有的图片历史预算投影（行为等价、跨版本一致）；视觉桥存活探针适配 cordis ≥ 4.0.6 的 bus 布局（最后一个监听器注销后 hook 键被移除，可读总线上的缺失键判定为「无桥」而非不可读）
- **Gemini 3.8 / 3.7 Flash 路由实体修正（Refs #15、#16）**：免费 project 不存在 rollout 期的 `*-tiered` 实体，3.8 / 3.7 Flash 现按思考等级路由到后端真实通告的 `-low` / `-medium` / `-high` 实体，并随请求发送对应 `thinkingConfig.thinkingLevel`；设置页 3.8 的可用性探针不再误匹配 3.7 行（#16）
- Claude Sonnet 4.6 运行时实体改为后端实际通告的裸 `claude-sonnet-4-6`（此前指向不存在的 `-thinking` 实体）
- 代看模型自动挑选优先 Flash 线（避免默认启用旗舰后每张图都烧 Pro 额度），空配置兜底改为 `gemini-3.8-flash`（全档位可用）；探活请求同样固定以 3.8 Flash 为兜底，不再默认打 Pro 专属的旗舰实体

### 验证
- `npm run check` 114/114（v0.8.2 基线 104 项全保留 + 新增 `test/models.test.mjs` 6 项：新版目录四模型存在性、新实体路由解析、token 上限、实体/标签匹配、级别后缀剥离、排序与 deprecated 标记；新增 `test/catalog-availability.test.mjs` 4 项：实体存在才标可用并继承额度（Refs #16）、缺失实体标不可用、sonnet 4.6 裸实体匹配、内部实体过滤；vision-tool 两项断言随 3.7 路由实体与兜底模型更新）

## v0.8.2 — 2026-10-05

### Fixed
- **DSH Desktop 用户代理不生效，登录永远拿不到账号（#12，PR #13）**：宿主只在启动时从 harness home 的 `.env` 读取 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`（这几个名字写在其它任何 `.env` 里都会被宿主拒绝），而 DSH Desktop 的 harness home 不是 `~/.dsh`——Windows 在 `%APPDATA%\dsh-desktop\harness`，macOS 在 `~/Library/Application Support/dsh-desktop/harness`。README 此前只写抽象的 `$DSH_HOME`，桌面用户把代理写进 `~/.dsh/.env` 完全不生效：浏览器授权成功，换 token 阶段直连超时（`UND_ERR_CONNECT_TIMEOUT`，约 10.6 s），账号不落盘。现 README（中英同步）新增「🧱 网络环境（需要代理时）」一节：给出 CLI 与桌面版两种安装方式的实际 `.env` 路径、「写完必须完全退出并重启 DSH」的提醒与自检方法（直连 vs 走代理各请求一次 token 端点，走通返回 400）；「账号池与调度」小节同步标注桌面版凭证存储路径
- 换 token 的三处 `fetch(TOKEN_URL)`（`loginAntigravity` / `exchangeOAuthCode` / `refreshAntigravityToken`）封装为 `requestToken()`：传输层失败（`ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT` / `UND_ERR_CONNECT_TIMEOUT` / `UND_ERR_SOCKET` / `fetch failed` 等 9 个标记，取 `error.cause.code ?? error.code` 加 message 匹配）时，错误信息直接附上「疑似需要代理 + `.env` 该放哪」的自查指引（`proxyRemedy()`），不再以裸 `TypeError` 冒出。HTTP 层错误（`!response.ok`）的既有文案与行为不变；`refreshAntigravityToken` 的 30 s `AbortController` 透传语义不变——abort 归入非网络分支并保留 `cause`，不会误报「需要代理」

### 验证
- `npm run check` 103/103（v0.8.1 基线 98 项全保留 + 新增 `test/token-transport.test.mjs` 5 项：remedy 路径格式、不可达标记识别与 enrichment、非网络错误不带代理指引、fetch mock 成功响应透传与传输失败 enrich 两路）
- fork PR 的 workflow 因首次贡献需维护者批准未自动触发，已按 CI 同款步骤（`npm install --no-audit --no-fund` + `npm run check`）本地复跑替代；根因与三组运行时实测（直连 10753 ms 超时 → 系统代理 400/722 ms → 桌面自带运行时与真实 `loadLayeredEnv()` 路径 400/1213 ms）见 issue #12

## v0.8.1 — 2026-10-05

### Security
- **`/antigravity/api` 前缀接入宿主准入栅栏**：此前插件全部 web 路由（status / doctor / quota / login / logout / accounts\* / config / models）在 dispatcher 层无鉴权——宿主组合层的既有姿态是「鉴权属各路由 owner」，而本插件从未认领。现路由 handler 开头调用宿主 `connection.admit(request)`（与宿主自有 `/api` 通道和 WebSocket 升级同一原语）：Host/Origin 信任检查不过返回 403、无 DSH 浏览器会话返回 401，拒绝发生在任何路由逻辑之前（池状态、凭证、doctor 输出均不可达）。设置页卡片与已登录浏览器同源携带会话 cookie，不受影响；Google 登录的 OAuth 回调走独立本地端口（`ANTIGRAVITY_CALLBACK_PORT`），与栅栏无关。注入声明由 `["webServer"]` 改为 `["webServer", "connection"]`

### Fixed
- **自动看图桥接改写蒸发，模型始终收到占位文本（Refs #7，断点⑤）**：桥原挂在宿主 `llm/stream` 事件，监听器把改写后的消息作为 `next()` 参数传递；而 cordis waterfall 的 `next` 是零参闭包（监听器传入的参数被静默丢弃），`llm/stream` 内建又闭包捕获原始请求、忽略一切调用参数——改写从未到达 provider。日志层 `rewrote` 行照常出现，成为假阳性；历史「隔离环境正常」实为 `antigravity_read_image` 工具回退被误归因。修复：桥迁至 `agent/pre-step`（沿用宿主 `installModelSelection` 的「`await next()` 后改写、返回新 decision」模式，宿主消费返回值并随会话持久化）。`isEnabled` / `isTextOnlyModel` 门、池转述调用、进程内缓存、fail-open、决策链日志语义全部保留；`antigravity_read_image` 工具路径不变。覆盖边界：贴图（本步新输入）走桥；工具结果图片块（如宿主 `read_image` 返回）不经桥，保持占位文本加工具回退
- `/antigravity-doctor` 的 `visionBridge` 行改为读取时实时探测事件总线：`registered`＝桥此刻在线；新增 `dropped`＝注册成功后已从总线消失（issue #7 故障签名），重启宿主或重载插件可恢复；总线布局不可读（宿主漂移）时回退注册簿记值，不误报
- README 排障段措辞修正：doctor 返回的 vision 状态是三行（含 `visionEnabled`），原文「查看两行」已改为「vision 三行」（中英同步）

### Added
- **对话命令真实注册（兑现 README 命令表）**：`/antigravity-login`、`/antigravity-quota`、`/antigravity-doctor`、`/antigravity-logout` 此前只是文档承诺——宿主 `commands` 注册表里从未挂载（与 PR #9 补齐的 doctor 路由同类的文档-代码缺口）。现经宿主 `commands` 服务真实注册，handler 复用 web API 路由的同款进程内函数（单一代码路径，无 HTTP 往返）：login 返回授权链接、quota 刷新并按账号列额度、doctor 返回自检全文、logout 须显式带 `confirm` 参数（防误触移除全部凭证）。宿主未提供 `commands` 服务时优雅降级：不注册、不影响插件加载，web API 与 `antigravity-login` CLI 仍可用（中英 README 命令表同步更新）
- `/antigravity-doctor` 可调用入口（Refs #7）：`GET /antigravity/api/doctor` 返回 doctor 全文（含 `visionEnabled` / `visionBridge` / `visionShim` 三行），只读、拒绝非 GET。README 排障段此前让用户「运行 /antigravity-doctor」，但路由表从未提供该入口（PR #8 遗留缺口），现已按真实入口改写调用说明（中英同步）；快速开始版本口径同步如实区分（整包 0.2.0-rc.2 / 视觉路径另在 0.2.1-alpha.1 验证）
- 看图桥接决策链可观测（Refs #7）：桥在每条异步路径输出一行判定日志（请求进入、模型判定、改写结果或放行原因），贴图后服务端日志里零 `[Antigravity Pool Vision]` 前缀行，就是「事件没有到达桥」的直接证据；模型判定 resolver 的 unavailable / error 两态、shim 安装结果全部落日志；`/antigravity-doctor` 新增 `visionEnabled` / `visionBridge` / `visionShim` 三行组装状态；池 init 失败不再静默（记入 doctor 状态并告警）。纯观测改动：桥所有分支的判定与放行行为与 v0.8.0 等价（根因修复见上方 Fixed）

### 验证
- `npm run check` 84/84（v0.8.0 基线 75 项全保留 + 新增 9 项：决策日志契约、四种失败注入读出两两可区分、doctor 段）；两处 mutation 反证（入口正向控制日志、doctor vision 行）先红后恢复；semgrep 1 findings 为 v0.8.0 已记录的 buildModelMatchRegex 基线项，本次新增代码零 findings
- 桥迁移（Fixed）验证：`npm run check` 87/87（pre-step 契约全套重写：enter 改写 / reject 与无图与非纯文本透传 / gate 抛错 / 缓存与并发 / fail-open；存活探针回归含真实 cordis 注册→注销翻转）；隔离 web 副本（DSH 0.2.1-alpha.1）GUI 贴图端到端：决策链三行日志、用户消息持久化为池转述、模型零工具调用直答内容与测试图真实几何吻合，轨迹解码确认模型侧无占位文本
- doctor 入口（Added）验证：`npm run check` 88/88（新增路由测试：GET `/antigravity/api/doctor` 返回含三行状态、非 GET 405）
- 对话命令（Added）验证：`npm run check` 全绿（新增 `test/commands.test.mjs` 8 项：四命令注册与统一注销、无 commands 服务不抛错、login 展示授权链接、quota 逐账号刷新并触发适配器更新与额度行渲染、空池引导文案、doctor 原文透传、logout 无 confirm 拒绝且 confirm 后全量移除、handler 异常沉降为 error 结果）
- 准入栅栏（Security）验证：`npm run check` 全绿（vision-diagnostics 新增 401/403 两态用例：admit 拒绝时 doctor 与 login 路由在任何业务逻辑前返回对应状态码与 unauthorized/forbidden 文本；既有 200/405 用例在 admit 通过态下不变）

## v0.8.0 — 2026-10-01

### Added
- 视觉旁路：主模型无视觉时贴图由池内 Gemini 转述为文字回喂。新增 `antigravity_read_image` 工具（接受附件哈希前缀 / 本地路径 / data: URL / http(s) 公网图片链接）、贴图准入 shim（给纯文本模型的 `resolveModelInfo` 补报 image 模态，`ANTIGRAVITY_VISION_ENABLED=false` 或 `visionEnabled: false` 可关）、`visionEnabled` / `visionModel` 池配置字段
- 自动看图桥接（llm/stream）：无视觉主模型贴图时，发往模型的请求里图片块自动替换为池内 Gemini 的文字转述，模型无感获得看图能力；同一张图进程内缓存只转述一次，转述失败自动退回宿主占位路径不阻塞对话，转述文本附原始哈希可供 `antigravity_read_image` 显式细看；`visionEnabled` 开关同时控制贴图准入与自动转述
- `antigravity_read_image` 支持 http(s) 图片 URL：仅限公网地址（DNS 解析后逐记录校验，防 loopback / 内网 / 云元数据目标与 DNS rebinding）、redirect 手动跟随且每跳重校验（上限 3 跳）、15 秒超时、仅接受 image/* 响应、10 MiB 字节上限（content-length 预检 + 流式计数双保险）
- 设置页新增「视觉旁路」卡片：`visionEnabled` 开关与 `visionModel` 代看模型下拉（非生图 Gemini 模型），与自动桥接共享同一开关语义

### Security
- CI 加固：`.github/workflows/check.yml` 的 actions/checkout 与 actions/setup-node 从 mutable tag 钉到 commit SHA（dependabot 仍会提 PR 更新）；`.github/dependabot.yml` 两组依赖各加 14 天冷却期，降低新发布版本的供应链风险
- `buildModelMatchRegex` 入口加输入类型与长度防御（超 200 字符直接返回永不匹配模式），动态正则路径不再可能被超长输入触达（semgrep ReDoS 基线项，原实现输入已转义、风险本就很低）
- `antigravity_read_image` 的本地路径输入限制在工作区根与 DSH 附件库之内，越界即拒绝——此前模型可传任意绝对/穿越路径读取进程可访问的文件并上传 Google（Codex review P1）
- 附件对象与本地文件的 MIME 类型改为字节魔数嗅探（PNG/JPEG/WEBP/GIF），不再恒报 image/png

### Fixed
- 生图结果卡片的渲染文本此前显示 undefined：DSH 宿主调用工具 `output.render` 时第一个参数是调用入参、第二个才是 execute 返回值，`antigravity_image_generate` 的 render 按单参数声明取错了位置。改为双参形态，路径与 markdown 从返回值取
- `visionEnabled` 支持热切换：准入 shim 每次调用运行时判定开关状态（env 覆盖 + 池配置），设置页开关即刻生效，无需重启宿主
- 视觉池请求的 SSE error 帧不再被静默吞掉：quota 错误帧现在正确触发账号冷却与切换，不会再返回截断描述或抛笼统错误
- 视觉池请求的 fallback runtime 候选真正生效：主 runtime 遇 retryable 状态（404/429/5xx）自动换下一候选，与流式路径双层循环对齐；请求整体加 60 秒超时
- 显式配置的 `visionModel` 需通过能力校验（Gemini 且接受图片输入且非生图模型），选了纯文本或生图模型时回落自动挑选并告警

### 验证
- `npm run check` 69/69（v0.7.3 基线 34 项全保留 + 新增 35 项：视觉工具/桥接 waterfall 契约/SSRF 守卫/shim 分支/render 签名回归）；先红后绿证据留存
- 装包实测（隔离 profile + GLM-5.3 无视觉主模型）：贴图零工具调用、模型直接给出图片精确描述（区分下拉选中态与悬停态）；设置页卡片渲染与开关交互实测；三轮 GUI 实测含两个真实 bug 的发现与修复（render 签名、waterfall 契约）
- semgrep：v0.7.3 的 5 项基线 findings 全部消除，新增代码零 findings

## v0.7.3 — 2026-09-30

### Added
- `package.json` 的 `engines` 新增 `dsh` 声明：`">=0.1.7-rc.2 <0.3.0"`。npm 包发布后，dsh-market 插件市场的卡片会读取 npm manifest 里的 `engines.dsh` 显示宿主版本要求（此前 GitHub-only 分发，市场显示「未声明宿主要求」）。范围下限对齐 devDependencies 钉住的 0.1.7-rc.2，0.2.0-rc.2 宿主在范围内

### 验证
- `npm run check` 34 项全绿；`npm pack --dry-run` 核对发布清单

## v0.7.2 — 2026-09-29

### Changed
- README（中英同步）：删除 v0.6.0 曾融合 dsh-codearts-auth 的历史叙述句——历史归 CHANGELOG，不挂在 README 给新用户添噪音；「快速开始」新增环境要求声明：适配 DSH 0.2.0-rc.2（`dsh --version` 查看）

### 验证
- 文档-only 变更；`npm run check` 34 项全绿，确认无意外波及

## v0.7.1 — 2026-09-29

### Fixed
- **带图会话整轮失败（严重，[PR #3 修复提交](https://github.com/Q2297045667/dsh-gemini-pool-next/commit/cc896c0cc8eee1c61786b5aded44ee1cd6970383)，作者 [tensor-x](https://github.com/tensor-x)）**：`prepareRequestImages` 调用宿主 `attachments.readImageRequest` 时传的是 `{ maxPixels, maxBytes }`，而 DSH 的 `ImageRequestTarget` 契约要求 `width` / `height` 为安全正整数（`dsh-attachment` 的 `validateTarget` 逐一校验，缺 width 即抛 `Image request width must be a positive integer.`）——消息里只要有图片附件，本轮请求在组装阶段就抛错。修复为从附件 ref 自带的 `width` / `height` 出发，vendored 一份 `dsh-attachment` 的规范函数 `requestImageDimensions(width, height, maxPixels)`（按 `REQUEST_IMAGE_MAX_PIXELS` = 2048×2048 等比缩小），与 `{ maxBytes }` 合并成合法 target 传入。附件 ref 的 `width` / `height` 由 DSH 附件存储发布时写入（`ImageAttachmentRef` 必填字段），插件侧直接使用即类型安全；未带 `attachmentId` 的 inline 图仍走原有 legacy base64 路径，不受影响

### Added
- `test/adapter-image-target.test.mjs`（作者 tensor-x）：走真实路径的回归测试——真实 `AccountPoolManager` + `AntigravityPoolAdapter` 构造，fake attachments 捕获实际收到的 target，断言 `width` / `height` / `maxBytes` 均为安全正整数

### Removed
- 移除过期的 `PROJECT_STATUS.md`：内容冻结在 v0.5.3 时代（2026-09-26），与当前仓库状态不符；仓库现状以 README 与 CHANGELOG 为准

### 验证
- 守卫先证红：在未修复的 master（ad8fecb）上仅带入新测试文件运行，1 项失败（`AssertionError: width must be positive int`，旧代码传出的 target 无 width），精确复现线上症状；修复分支上 `npm run check` 34 项全绿（含 `node --check` 六文件）

## v0.7.0 — 2026-09-28

### Removed
- **移除融合的 dsh-codearts-auth provider，回归 Gemini 单渠道**：不再捆绑 `codearts` / `buddy` / `workbuddy` / `lobsterai` / `qoder` / `trae` / `cline` / `loomy` / `raccoon` 九条第三方路由。需要这些通道请单独安装 [dsh-codearts-auth](https://gitee.com/iJetLi/deepseek-harness-codearts)（作者 Jet，MIT）
  - 删除 `lib/vendor/codearts/`（77 个文件，含 `qoder-auth-wasm.wasm`）及 `lib/index.js` 中对上游 `apply(ctx)` 的调用；`lib/client.js` 移除 id 为 `dsh-codearts-auth` 的 Jet Hub 客户端块，文件约 196KB → 65KB
  - 设置页只剩 Antigravity（Gemini 账号池）面板，`antigravity` 路由行为不变
- `package.json`：移除 `dependencies` 里的 `jose`（仅上游使用，运行时零依赖）；`description` 与 `keywords` 去掉 Cloud Code Assist，改标 `gemini`

### Changed
- 插件 `inject` 由 `["llm", "credentials", "commands"]` 回落为 `["llm"]`（`export const inject` 与 `apply.inject` 同步），不再依赖宿主的 credentials / commands 服务
- `test/client-render.test.mjs`：`loadGeminiSource()` 的截取逻辑保留，注释更新为单模块现状

### 验证
- `npm run check`：`node --check` 全部通过，`node --test` 33 项全绿（渲染回归、池状态机、探活、适配器错误路径）

## v0.6.0 — 2026-09-26

### Added
- **融合 dsh-codearts-auth 的 9 条 provider 路由**：`codearts`、`buddy`、`workbuddy`、`lobsterai`、`qoder`、`trae`、`cline`、`loomy`、`raccoon`。装本插件即同时具备这 9 条通道与原有的 `antigravity`，不必再单独安装 [dsh-codearts-auth](https://gitee.com/iJetLi/deepseek-harness-codearts)（作者 Jet，MIT）
  - 复用而非重写：上游 TypeScript 源码经 esbuild 转译为 ESM 后整体置于 `lib/vendor/codearts/`（77 个文件，含 `qoder-auth-wasm.wasm`），其 MIT 许可证原文保留在同目录 `LICENSE`。本插件只做了接入，没有改上游实现
  - 接入方式：`lib/index.js` 的 `apply()` 末尾调用上游的 `apply(ctx)`，一个调用注册全部 9 条路由，与 `ctx.llm.registerAdapter` 同源（上下游都从 `@deepseek-ai/dsh-llm` 取 `LlmAdapter`）
  - 前端同理：上游 Jet Hub 客户端 bundle 以独立的 `window.__ModuleLoader__.load({ id: "dsh-codearts-auth" })` 块并入 `lib/client.js`，与本插件的设置页块并列，各自注册 `settings.section`
  - **失败隔离**：这 9 条路由依赖宿主的 `credentials` / `commands` 服务。上游 `apply()` 包在 try/catch 内，服务缺失或版本不匹配时只放弃这 9 条路由并打一条 warn，`antigravity` 路由照常注册
- `package.json`：`dependencies` 新增 `jose`（DPoP 签名，上游运行时依赖）；`peerDependencies` 新增 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/schemastery`（均 optional，由宿主提供）

### Changed
- 插件 `inject` 由 `["llm"]` 改为 `["llm", "credentials", "commands"]`（`export const inject` 与 `apply.inject` 同步）
- `test/client-render.test.mjs` 与 `test/client-render-populated.test.mjs`：新增 `loadGeminiSource()`，只取 `lib/client.js` 中 id 为 `dsh-gemini-pool-next` 的那个模块块做静态扫描与执行；`__ModuleLoader__.load` 的桩也改为按 id 过滤。原因是 client.js 现在含两个模块块，不区分会让上游 Jet Hub 块的组件覆盖被捕获的本插件组件，导致 7 项渲染测试误报失败

### 本版本未覆盖的验证
- **9 条融合路由的真实登录与调用未做端到端验证** —— 需要各平台的真实账号，当前环境没有。已验证的是：77 个 vendor 模块可正常 import、上游 `apply()` 可被调用、失败隔离生效（无宿主服务时只 warn 不崩）、原有 33 项测试全绿
- `npm install` 在本机需用 `--legacy-peer-deps`：仓库原有的 `@deepseek-ai/dsh-host-webserver` 与 `dsh-invariants` peer 冲突在本次改动前就存在，未在本次修改

## v0.5.3 — 2026-09-26

### Fixed
- **设置页整页空白（严重）**：设置页组件引用了两个从未声明的变量（`localeRev` / `setLocaleRev`，本意是语言切换后重渲染）。该引用位于组件渲染函数体内，一执行就抛 `ReferenceError`，React 随即卸载整个设置分区——表现就是「打开设置，插件卡片是空白的」。补上缺失的状态声明。已用真实渲染测试复现：修复前 18 项渲染测试中 13 项失败（失败栈为 `ReferenceError: localeRev is not defined at GeminiSettingsPage`），修复后 33 项全绿

### Added
- **客户端渲染回归测试（9 项）**：此前所有检查都是静态的（语法检查、i18n 键覆盖、模块导入、HTTP 接口探测），全部通过却漏掉了「组件根本渲染不出来」这类问题。新增测试会真正执行组件渲染函数：
  - `test/client-render.test.mjs`——空数据渲染不抛错、渲染输出非空且含预期标题、所有被调用的 `set*` 与 hook 依赖项都有声明
  - `test/client-render-populated.test.mjs`——用真实接口响应（已脱敏）渲染，断言账号行、额度行、模型列表都出现在输出里，并断言「打开面板即自动刷新额度」这条行为
  - 两个文件都做了反向验证：把修复回退后测试确实变红，确认它们真能抓住这个缺陷
- `scripts/build-status-fixture.mjs`——从本机 `/antigravity/api/status` 抓取真实响应生成测试夹具，自动脱敏（邮箱、账号 id、令牌），若发现未脱敏邮箱则拒绝写入。该脚本刻意放在 `test/` 之外，避免被 `node --test` 自动执行而改写已提交的夹具

## v0.5.2 — 2026-09-25

### Fixed
- **账号在重启后丢失（严重）**：账号池加载校验的是一个实际不存在的字段（`accessToken`），而账号真正持有的是 `access` / `refresh`——导致每次进程重启从磁盘读回时，已保存的账号在校验阶段抛错、被静默吞掉，池加载为空（有旧凭证文件时甚至被单账号迁移覆盖）。改为校验真正的持久字段 `refresh`（access 是临时令牌、可按需刷新，legacy 迁移账号允许为空）。已用「保存→新实例重载」实测复现并验证修复
- **损坏的池文件不再静默丢弃**：池文件存在但无法解析时立即报错（携带文件路径与原因），不再静默清空并让迁移逻辑覆盖可恢复的文件

### Added
- 3 项账号池持久化回归测试（重载存活 / 空 access 仍可加载 / 损坏文件报错且不被覆盖）

### Changed
- 设置页无障碍与打磨：表单控件与 `<label>` 显式关联、额度条补 `role="progressbar"` 与 aria 值、错误/保存提示加 live region、折叠区补 `aria-expanded`、`:focus-visible` 焦点环、点按反馈与 `prefers-reduced-motion` 适配；「当前使用」标签补中英双语（行为、接口、数据流未变）
- 文档梳理：README 中英去营销腔并对齐、修英文版破损 HTML 与语义漂移、CHANGELOG/SECURITY 轻度润色

## v0.5.1 — 2026-09-25

### Fixed
- **请求失败路径崩溃修复**：`triedEndpoints` / `lastNetworkError` 原声明在候选循环内部、却在循环外的错误分支被引用，导致任一请求彻底失败时抛 `ReferenceError` 而非分类后的 `LlmError`。该 `ReferenceError` 无法被 `isQuotaOrRateLimitError()` 识别，使得账号在「所有候选均 429」的常见场景下既不进入冷却、也不自动切号——多账号 429 容灾在该路径下形同虚设。现将两变量提升至请求级作用域
- **并发刷新令牌加锁**：同一账号的多路请求 / 后台探活并发触发刷新时，会用同一个（旧的）`refresh_token` 同时打 Google 令牌端点；Google 每次刷新都会轮换 refresh_token，并发刷新可能互相作废并导致账号被刷废。新增 `refreshAccountTokenOnce()` 按账号合并在途刷新

### Added
- 回归测试：所有候选 429 耗尽时须抛出限流错误（非 ReferenceError）并正确记一次冷却

### Docs
- README 手动安装示例的包名去掉写死版本号，改用 `dsh-gemini-pool-next-*.tgz` 通配

## v0.5.0 — 2026-09-25

### Changed
- **探活恢复改为递减信任制**：后台探活成功后账号重新启用，但 `failureCount` 只递减 1（新 `recordProbeSuccess()`）——一次探活成功不再把真实失败史一笔勾销，账号需连续多次探活成功才能完全重获信任；设置页手动「重新启用」仍为全重置语义

### Security / Hardening
- 生图产物落盘前校验大小（上限 20 MiB），拒绝无界 base64 写盘
- 设置页 Web API 请求体上限 2 MiB，超限拒绝
- 账号池加载：结构性损坏（缺 `id` / `accessToken`）立即报错并携带坏值，不再静默吞掉坏条目
- 设置页表单：冷却参数未配置时显示为空，不再用硬编码默认值伪装成“已配置”
- 可重试状态码收敛为 `RETRYABLE_STATUSES` / `PROBE_RETRYABLE_STATUSES` 两个单一常量（原先三处独立硬编码数组）

### Added
- 3 项探活恢复行为测试（递减信任 / 不穿透零下限 / 手动解禁全重置）

### Internal
- 诊断单例显式化：`lib/diagnostics.js`（`createDiagnostics()` 工厂 + 共享实例），为后续模块拆分铺路
- 模块拆分持续推进：`lib/models.js`、`lib/text-and-format.js` 已剥离（行为零变化，导出面 32 不变）

## v0.4.1 — 2026-09-25

### Fixed
- 账号成功响应不再清零累计失败计数：间歇性坏号的退避阶梯与 `disableThreshold` 退役机制恢复生效（新增 `clearCooldownUntil()` 只清冷却窗口；`clearCooldown()` 保留手动解禁的全重置语义）
- 禁用账号的探活恢复改走真实 `streamGenerateContent` 文本通道（1-token 最小探测）：配额元数据查询不再能“假阳性复活”被限流的账号
- 账号池整体耗尽时报 `EXHAUSTED` 而非 `AUTH`，不再误导用户重新登录
- 生图路径与流路径统一使用同一配额/限流判定（收紧后的 `isQuotaOrRateLimitError`），400 类错误文本中偶然出现的 "quota" 字样不再误伤账号
- 流式输出中途遭遇 429 时同样标记冷却（不再换号续流，保持响应完整性）
- 生图成功路径补漏 `await`；修正 `package.json` 的 `files` 字段：把已改名的 README.zh.md 更正为 README.en.md

### Added
- GitHub Actions：push / PR 自动跑 `npm run check`（零依赖，无 install）
- 6 项行为回归测试（冷却语义 / 探活通道与模型 / 池耗尽错误码 / 中流 429 / 生图误判），全部先以失败态验证过对应 bug 真实存在

## v0.4.0 — 2026-09-25

### Added
- 首次公开版本：Google AI Pro / Ultra 订阅账号池接入 DSH（Antigravity / Cloud Code Assist 通道）
- 多账号额度均衡、429 自动切换、坏号冷却与探活恢复、设置页账号卡片与每周 / 5 小时额度展示、生图工具接入
