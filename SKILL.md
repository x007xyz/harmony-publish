---
name: harmony-publish
description: >
  当需要将 HarmonyOS (ohos) 项目发布/上架到华为应用市场 (AppGallery Connect) 时
  必须使用——发布 harmony 项目 / 上架 / 调用 harmony-publish / 发布到华为应用市场。
  覆盖完整发布流程:项目注册与配置、AGC APP ID + Release Profile + 签名、带官方
  校验的 release 构建、商店截图、应用信息(分类/标签/图标)、版本草稿(国家/文案/
  截图/年龄分级/隐私托管/联系方式)以及最终提交。优先使用华为官方
  Provisioning、Upload Management 与 Publishing API；仅对未开放接口、人工验证
  和首次配置使用 AGC 控制台自动化。

  不适用于:修改应用本身、从零撰写商店文案(应从应用实际功能出发起草)、
  或非 HarmonyOS 目标。
---

# HARMONY 应用发布 (AppGallery)

将 HarmonyOS 应用(原生 `AppScope/` 布局 或 带 `ohos/` 子目录的 Flutter 项目)
端到端发布到华为 AppGallery Connect (AGC)。

## 技能目录结构(单份源码,不再逐项目复制)

```
harmony-publish/
├── SKILL.md                  # 本文档
├── projects.json             # 项目注册表模板:每个应用的全部 AGC 参数(路径用 <HARMONY_ROOT> 占位,按本机环境填写)
├── secrets/                  # AGC Service Account 凭据(不随仓库分发;用 --credential 传入)
│   └── private.json          #   自行创建:开发者级 Service Account 密钥
├── references/
│   └── category-ids.json     # 官方分类/标签 ID 全量字典(26 二级分类+269 标签,中英对照)
├── certs/                    # 共享签名证书(不随仓库分发;自行放置)
│   ├── release.p12           #   签名密钥库
│   ├── release.cer           #   发布证书
│   ├── release.csr
│   └── material/             #   密码解密密钥材料(必须与 p12 同目录,hvigor 解密依赖)
├── tools/                    # 通用工具脚本(唯一副本,参数化)
│   ├── configure-release-signing.mjs   # node ... --project <根> [--target] [--profile]
│   ├── version-node.py                 # python3 ... --project <ohos|根> check|set
│   └── app-id/                        # APP ID 创建:AI 预生成参数 + Playwriter 一次性执行
│       ├── package.json               # 依赖 playwriter/playwright-core(无浏览器二进制)
│       └── create-app-id.mjs          # 幂等创建 APP ID(填表/项目/开放能力/验证 appId)
│   └── submit-check/                   # 版本页必填三项:发布国家所有/资费其它/个人信息否
│       ├── package.json               # 依赖 playwriter/playwright-core(无浏览器二进制)
│       └── submit-check.mjs           # 一次设置+保存+必填警告校验(已提交版本自动跳过)
│   └── age-rating/                     # 年龄分级问卷:AI 生成答案 + Playwriter 一次性执行
│       ├── package.json                # 依赖 playwriter/playwright-core(无浏览器二进制)
│       └── submit-rating.mjs           # 抓题目/作答/验证/提交(必须主菜单「版本信息>准备提交」进入)
│   └── privacy-agreement/              # 托管隐私协议:AI 生成参数 + Playwriter 一次性执行
│       ├── package.json                # 依赖 playwriter/playwright-core(无浏览器二进制)
│       ├── generate-copy.mjs           # 自动生成协议文案 JSON(供 AI 审核润色)
│       └── create-agreement.mjs        # 连接运行中的 Chrome,一次性完整创建协议
└── plugin/
    └── harmony-publish/      # OpenCLI 插件(唯一副本,多项目 --project 驱动)
```

插件已作为 `harmony-publish` 安装到 opencli,所有命令形如
`opencli harmony-publish <命令> --project <key>`,`--project` 接受
projects.json 的 key、项目绝对路径或 displayName。

## 前置条件(每个会话检查一次)

- **首次使用配置**:见下方「首次使用配置」章节,向用户询问并持久化到
  `config.json`(不随仓库分发)。
- 优先配置开发者级 AGC Service Account：`secrets/private.json`（技能目录内，
  勿提交到 git），通过 `--credential` 传入；或通过
  `HUAWEI_AGC_SERVICE_ACCOUNT` 环境变量。完整路由、安全约束与回退边界见
  [Connect API 路由](references/connect-api.md)。
- 仅在官方 API 不支持当前步骤时要求 `opencli doctor` 为绿色，并复用 Chrome 的
  `developer.huawei.com` 登录态。
- DevEco Studio 工具链:`/Applications/DevEco-Studio.app`(hvigorw、ohpm、
  hap-sign-tool)。
- 共享 release 签名证书:`<skill>/certs/release.p12` +
  `release.cer`(含同目录 `material/` 解密材料,不可分开移动);密码来源:
  `AIMosaic/build-profile.json5`(由 configure-release-signing.mjs 读取)。
- 默认审核人联系方式(除非用户另行指定):手机 `13800000000`、
  邮箱 `review@example.com`、姓名 `开发者` —— 写入各项目
  `release/appgallery.metadata.json` 的 `reviewContact` 字段,由
  `prepare-app-info` 官方 API 直接设置,无需短信验证。

## 首次使用配置

**每次新环境首次使用本技能时,必须先向用户询问以下信息,并写入技能目录的
`config.json`(gitignore 排除,不随仓库分发)。已存在 `config.json` 时直接读取,
不再重复询问;用户主动要求修改时更新。**

```json
{
  "reviewContact": {
    "name": "开发者",
    "phone": "13800000000",
    "email": "review@example.com"
  },
  "harmonyRoot": "/path/to/harmony",
  "signingPasswordSource": "/path/to/AIMosaic/build-profile.json5",
  "credentialPath": "/path/to/secrets/private.json"
}
```

询问清单(一次问完,不要挤牙膏):

1. **审核人联系方式**(姓名/手机/邮箱)—— 发布时写入
   `release/appgallery.metadata.json` 的 `reviewContact`,由官方 API 直接设置。
   用户不提供时用占位符,并明确告知"发布前必须替换为真实信息"。
2. **Harmony 项目根目录**(`harmonyRoot`)—— 用于替换 `projects.json` 中的
   `<HARMONY_ROOT>` 占位符。用户不提供时保留占位符,按项目逐个填写。
3. **签名证书密码来源**(`signingPasswordSource`)—— 指向包含签名密码的
   `build-profile.json5` 文件路径(configure-release-signing.mjs 读取)。
4. **AGC Service Account 凭据路径**(`credentialPath`)—— 指向用户自备的
   `secrets/private.json`;也可用 `HUAWEI_AGC_SERVICE_ACCOUNT` 环境变量替代。

**持久化规则**:
- `config.json` 写入技能目录根(`<skill>/config.json`),加入 `.gitignore`。
- 每次会话开始检查:存在则读取,缺失则询问。
- 用户提供的信息只用于本技能运行,不写入任何随仓库分发的文件。
- 审核人联系方式等敏感信息不得出现在 `projects.json`、`SKILL.md` 或任何
  提交到 git 的文件中。

## 项目形态很重要

- **原生 HarmonyOS 项目**(根目录有 `AppScope/`、`build-profile.json5`):
  命令传入项目根目录。
- **Flutter 项目**(HarmonyOS 代码位于 `ohos/` 下):`--project` 传项目根目录,
  插件自动用 `<根>/ohos` 作为构建目录。版本号由 `flutter-hvigor-plugin` 从
  `ohos/local.properties` 覆盖(`flutter.versionCode` / `flutter.versionName`),
  `tools/version-node.py` 会同步两者。

## 第 1 步 — 项目注册(新项目只需此步,不复制任何脚本)

1. 在 `projects.json` 中为新应用添加条目(从已有项目复制结构):
   - `projectRoot` 项目根目录;`flutter: true` 表示 Flutter 项目
   - `displayName`/`appName`/`bundleName`/`agcProjectName`/`profileName`/
     `profileFile` —— AGC 应用信息与 Release Profile 名
   - `appId` —— AGC APP ID(可从控制台 URL 发现,留空则运行时自动从页面读取)
   - `packageName`/`packageVersion` —— 已签名 APP 文件名与版本
   - `remarks` —— 审核备注(审核路径);`category`/`tag` —— UI 显示名;
     `harmonyChildType`/`kindMainTag` —— 官方 API 使用的数字分类/标签 ID
2. 若未安装插件:`opencli plugin install file://<skill>/plugin/harmony-publish`
3. 修改 `release/appgallery-publish.json`:plugin_site 为 `harmony-publish`,
   plugin_source 指向技能插件目录,nodes 中的 version-node.py 指向
   `<skill>/tools/version-node.py`(Flutter 项目 `--project {project}/ohos`)。
4. 更新 `release/appgallery.metadata.json`
   (appName/shortDescription/description/releaseNotes/privacyPolicyUrl
   `AGC_PRIVACY_HOSTING`、releaseCountries `["OTHER"]`(所有国家或地区)、
   pricing `free`、截图绝对路径、`reviewContact` 审核人联系方式{name/phone/email}、
   `screenshotsTablet` 平板竖屏截图绝对路径)。
5. `opencli doctor` 通过后开始发布。

## 第 2 步 — 官方 Provisioning API + release 构建

```
opencli harmony-publish agc-api --project <key> --action status
opencli harmony-publish agc-api --project <key> --action resolve-app-id
opencli harmony-publish agc-api --project <key> --action ensure-profile
opencli harmony-publish agc-api --project <key> --action download-profile
opencli harmony-publish configure-signing --project <key>   # 绑定 certs/release.p12/.cer + profile 为 "release" 产品
opencli harmony-publish preflight --project <key> --metadata release/appgallery.metadata.json  # 必须无拦截项
opencli harmony-publish build --project <key>      # ohpm install + hvigor assembleApp release + 官方校验
opencli harmony-publish artifact --project <key>   # APP 签名/bundle/版本/sha256
```

若 `resolve-app-id` 确认应用不存在，Publishing API 官方不支持创建应用；此时用
**Playwriter 脚本一次性创建 APP ID**（参数由 AI 预生成，连接运行中的 Chrome）：

```
node tools/app-id/create-app-id.mjs --project <key> [--app-name <名称>] [--bundle-name <包名>] [--project-name <项目名>] [--capabilities <能力,能力>]
```

流程：检测包名已存在则跳过（幂等）→ 新建 → 填应用名称/包名/应用分类 → 下一步 →
应用所属项目（输入新项目名 → 确认）→ 开放能力页（默认全部不勾选；`--capabilities`
按名勾选）→ 保存 → 回列表验证输出 `appId`。注意：确认后后端即异步创建 APP ID，
保存按钮可能延迟启用，脚本以**列表出现为准**。前置条件：Chrome 已装 Playwriter
扩展并连接、已登录 developer.huawei.com。

不得优先调用控制台私有接口或模拟点击来替代已开放的 Provisioning API。

`ensure-profile` 默认不写入“受限 ACL 权限”。仅当应用已经申请并获批对应权限且
明确提供 ACL 名称时才扩展 API 请求；不得猜测或把 ACL 当作普通 release 签名的
前置条件。

### 开放能力(create-app-id 时确认,默认全部不勾选)

创建 APP ID 后 AGC 会进入"开放能力"页。**必须与用户确认是否开通,默认全部不
勾选直接保存**。若用户需要某能力,用 `--capabilities <名称,名称>` 重跑
create-app-id(命令会按名称勾选后保存)。当前 AGC 开放能力清单(名称可能随
控制台更新):

- 待机屏保卡片、优先通知、背板透明卡片、锁屏卡片
- 认证服务、云存储、云托管
- 运动健康服务、WearEngine、接续服务

命令输出能力勾选状态(`capabilities` 数组);页面无确认按钮或能力无法读取时
会报错列出当前列表,交由用户决策。

继续前需修复的 preflight 拦截项:1024x1024 正方形
`AppScope/resources/base/media/app_icon.png`、商店截图(见第 4 步)、release 签名。

**图标来源优先级**:
1. `design/icon/export/`(或 `concepts/`)已有图标概念稿 → 从
   `design/icon/concepts/` 中挑选,询问用户选择哪个方案。
2. 无任何图标概念稿(即 `design/icon/` 下为空或不存在) → 加载 **image-gen
   skill** 先生成**多种风格**的图标概念稿(存 `design/icon/concepts/<风格>/`),
   展示给用户选择,确认后再导出 1024x1024 到 `AppScope/resources/base/media/app_icon.png`。

**图标生成铁律(2026-08-14,banzhuren 教训)**:
- **禁止白色边框/白色边缘**:AI 生成图标常自带白框白边,手机系统会按圆角/圆形
  遮罩裁切,白边在桌面上表现为难看的白框。生成描述必须显式要求「背景铺满到四边,
  无边框」;生成后用 `look_at`/`vision_chat` 验证边缘无白;仍带白边则用
  `--reference` 重生成无边框版,或用 PIL 裁剪白边后放大。
- **主体置于中心安全区**:粉笔手绘等细节型图标,内容应控制在画面中央约 70% 区域内,
  四边留出背景色留白,避免被系统圆角裁到主体。
- **导出全平台**:确认方案后除鸿蒙 `AppScope/resources/base/media/app_icon.png` 外,
  必须同步导出 Android `mipmap-*/ic_launcher.png`(48/72/96/144/192)、iOS
  `AppIcon.appiconset`(20/29/40/60/76/83.5/1024 各 @1x-3x)、macOS
  `app_icon_{16..1024}.png`、Web `icons/Icon-{192,512,256}.png` +
  `favicon.png`(Flutter 模板全平台图标默认是 Flutter Logo,漏换必被驳回)。

## 第 3 步 — Upload/Publishing API 优先

通过 Upload Management API 上传 APP、图标、截图，再用 Publishing API
关联文件、更新应用信息与多语言文案：

```
opencli harmony-publish prepare-app-info --project <key>     # 官方 API:应用信息/语言/图标
opencli harmony-publish app-info-status --project <key>      # 官方 API:读取状态
opencli harmony-publish upload-package --project <key>       # 官方 API:上传并关联 APP
opencli harmony-publish prepare-version-basic --project <key> # 官方 API:国家/文案/审核信息
```

分类/标签 ID 一律从官方附录字典获取，**不再需要 `prepare-app-info-ui` 登记**：
`references/category-ids.json`（26 个二级分类 + 269 个标签的中英文对照，抓自官方
「应用游戏分类」附录页，用已发布项目的 ID 验证过）。注册项目时 AI 直接读字典，
按 `category`/`tag` 中文名匹配 `byZh` 映射，将数字 ID 填入 projects.json 的
`harmonyChildType`/`kindMainTag`。中文名在字典中不存在时（如「效率」「班级管理」），
AI 选官方最贴切的标签并同步更新 projects.json 文本。只有 API 明确拒绝当前字段时
才使用 `app-info-status-ui` 或 `upload-package-ui`，并记录原因。应用名取自包 label，
必须与 `EntryAbility_label` 一致。

## 第 4 步 — 商店截图

截图来源按以下优先级,满足任一即停:

1. **已有截图直接使用**: `design/screenshots/final/` 下已有 `NN-<功能>.png`
   (1080x1920)时直接用,把绝对路径写入 `release/appgallery.metadata.json` 的
   `screenshots`。
2. **测试截图兜底**: 没有商店截图时,优先使用 **Golden 测试截图**
   (`test/goldens/` 或 `design/screenshots/` 根层级)或 **e2e 真机截图**
   (`qa_shots/e2e/`)。尺寸不是 1080x1920 的,先转换尺寸
   (居中+模糊背景填充)到 `design/screenshots/final/`。
3. **AI 生成(以 App 截图为参考)**: 测试截图没有或不够精美时,加载 **image-gen
   skill**,以 App 截图(Golden/e2e 测试截图,或 `design/screenshots/source/`
   素材)为**参考图**(`gemini-image-gen "描述" -o 路径 --reference <App截图>`),
   生成符合商店要求的介绍图(9:16 1080x1920、内容填满画面、突出核心功能),
   存 `design/screenshots/generated/`,被采用的版本复制到
   `design/screenshots/final/`。

人工精修(可选,用于替代/补充 AI 生成、保证内容填满画面):
1. `flutter build web --release`(Flutter 项目)+ 本地服务 `build/web`
   (`python3 -m http.server 8899`),或运行 macOS 构建。
2. 用浏览器自动化驱动:设置视口 `540x960`、DPR 2
   (= 1080x1920,AGC 推荐的 9:16 尺寸),点击 Flutter web 语义占位中的
   "Enable accessibility",再通过 a11y 树点击底部导航 tab;填写计算器
   份数输入框;逐个 tab 截图。
3. 客观校验:OCR(macOS Vision + Swift 脚本)+ 像素分析
   (底部留白 < 画面高度 3%;内容贯穿全高;无内部零内容段 > 20%)。
   若画面大面积空白则用更窄的视口重截。内容稀疏页面(列表项较少)可接受,
   但需向用户说明。
4. 更新 `release/appgallery.metadata.json` 中的 `screenshots` 为绝对路径。

**设备素材（手机+平板，全部走官方 Upload API）**：
- 手机(deviceType=4)：竖屏 `1080x1920`(9:16),showType=0
- 平板(deviceType=5)：竖屏 `1280x1920`(2:3),showType=0 —— **处理方式不变**:
  用与手机**同一套内容图**转换尺寸(居中+模糊背景填充),存 `design/screenshots/tablet/`
- 图标:同一张 `app_icon.png`(1024x1024)同时关联 deviceType=4 和 5
- 上传:`complete-screenshots` 手机用 `metadata.screenshots`,平板用
  `metadata.screenshotsTablet`(--device-type 5 时读取);`prepare-app-info`
  负责图标双设备关联

**发布国家或地区**:默认**所有国家或地区**(页面勾选「所有国家或地区」;
API `publishCountry` 用 `OTHER` 表示自动分发到全部及未来新增国家)。
`metadata.releaseCountries` 写 `["OTHER"]`。

## 第 5 步 — 版本草稿(API 优先)

```
opencli harmony-publish complete-screenshots --project <key> # 官方上传/文件 API
opencli harmony-publish screenshot-status --project <key>    # 官方查询 API
opencli harmony-publish set-app-info-phone-only --project <key> # 官方应用信息 API
# 年龄分级: 见下方 Playwriter 脚本流程（不配置 API Client, 全部走 UI）
```

年龄分级问卷：**Playwriter 脚本一次性完整执行**（全部 UI 路径，不做 API Client）。
问卷作答必须在 AGC 网页完成（华为明确不做问卷 API），但人工环节可完全去掉：
AI 预生成答案 → 脚本自动作答/验证/提交：

```
# 1) 抓取问卷题目到本地（若本地已有题目/答案文件可跳过此步）：
#    questions 阶段会把问卷题目抓取并保存到 release/age-rating-questions.json，
#    AI 据此 + 应用真实功能生成答案 JSON
node tools/age-rating/submit-rating.mjs --project <key> --stage questions
# 2) AI 生成 release/age-rating-answers.json:
#    { "yesIds": [...], "expectedAge": "年满 3 周岁", "childFlag": 0 }
#    无敏感内容 = yesIds 空数组；不得伪造答案
# 3) 提交阶段【必须传 --answers 答案参数】，否则脚本挂起等待：
#    脚本内部会自行抓取题目并作答→验证→预期分级→提交→儿童确认→保存；
#    已预生成答案（基于应用真实功能）时可直接从本步开始，无需先跑 questions
node tools/age-rating/submit-rating.mjs --project <key> --stage submit --answers release/age-rating-answers.json
```

**答案参数必传**：`--answers` 是 `submit`/`answers` 阶段必需的参数（脚本校验：
非 questions 阶段缺 `--answers` 直接报错退出）。若直接跑 `submit` 卡住，
先确认是否漏传 `--answers`。

前置条件：Chrome 已装 Playwriter 扩展并连接、已登录 developer.huawei.com；**应用分类
/标签已通过 `prepare-app-info` 写入**（否则问卷会弹「请先完善应用分类信息」）。
**必须通过主菜单「版本信息 > 准备提交」进入**（手动改 iframe src 会导致验证接口
`srvSerialNo` 为空报错；已提交审核的版本菜单为「等待审核」，脚本自动识别跳过）。

**版本页必填三项**（发布国家「所有国家或地区」、应用内资费「其它」、是否涉及
个人信息收集「否」）—— 资费已 API 化（metadata `appTariffType: "6"`）；发布国家
与个人信息收集为版本草稿级字段（app-info API 无等价），用 `submit-check.mjs`
一次性设置+保存+校验：

```
node tools/submit-check.mjs --project <key>
# 输出 { ok, countries, fee, privacy, changed, saved, warningCleared }
# 已提交审核的版本自动识别跳过;幂等:三项已设则无改动不保存
```

`rating-draft-ui`（opencli DOM 自动化）仅作为 Playwriter 不可用时的回退。

首次创建托管隐私协议：**Playwriter 脚本一次性完整执行**（AI 预生成参数 → 脚本自动
完成全流程，无需 LLM 逐步确认）。脚本通过 Playwriter 扩展连接**正在运行的 Chrome**
（保留 developer.huawei.com 登录态），不启动新浏览器：

```
# 1) 生成文案初稿（从 projects.json/metadata/remarks 自动提取）
node tools/privacy-agreement/generate-copy.mjs --project <key> --out release/privacy-agreement.json
# 2) AI 审核/润色 release/privacy-agreement.json（按应用真实功能；检查 functions
#    无「审核路径：」等杂质、intro 完整、email 为默认联系邮箱）
# 3) 一次性完整执行（新建协议→切「隐私政策」类型→填全部字段→生成→验证）
node tools/privacy-agreement/create-agreement.mjs --project <key> --copy release/privacy-agreement.json [--force]
```

前置条件：Chrome 已装 Playwriter 扩展并点击图标连接（tab 图标变绿）、已登录
developer.huawei.com。同名协议已存在时默认跳过并输出已有信息；`--force` 先删除
重建。脚本输出 `agreementId`/托管链接，并写入
`<projectRoot>/release/privacy-agreement-result.json`。若应用 module.json5 声明了
敏感权限，脚本会警告（需在控制台手动补充权限声明）。

创建后更新/提交走官方接口：

```
opencli harmony-publish privacy-agreement --project <key> --action update --agreement-id <id> --body-file <agreement.json>
opencli harmony-publish privacy-agreement --project <key> --action submit --agreement-id <id> --confirm-submit true
opencli harmony-publish user-agreement --project <key> --action create --body-file <agreement.json>
```

`protocol-draft-ui`（opencli DOM 自动化，脆弱）仅作为 Playwriter 不可用时的回退。

官方 API 的 PUT 成功后草稿已持久化，不再需要保存草稿的 UI 命令。
`prepare-version-basic-ui`、`complete-screenshots-ui`、`screenshot-status-ui`、
`set-app-info-phone-only-ui`、`version-inspect-ui` 仅为明确不支持时的回退。

### 版本表单决策 —— 预生成默认值,不在页面确认

以下所有决策都是默认值,必须自动应用。完整表格及分类/标签映射见
`references/presets.md`:

- 备案/APP类型: **单机APP**(免除备案身份证字段;点击 radio 的 label 选中,
  等待 Vue flush 后再校验——早期尝试的过期错误会残留)。
- 内容分级:根据应用真实内容填写官方问卷；不得用“默认全部否”替代事实判断。
- 上架时间: **审核通过立即上架**——除非用户要求,绝不碰日期选择器。
  "上架时间不能小于当前时间"报错通常是过期的(来自之前"此刻"选择器交互,
  会填入一个已过去的时间);重新加载并重新校验即可。
- 联系方式:手机/邮箱/姓名来自 presets(默认值见上,除非用户另行指定)。
- 文案(name/shortDescription/description/releaseNotes/remarks):根据应用的
  真实功能按 presets 模板撰写,写入 metadata——不在页面确认。
- 分类/标签:按 presets 分类映射选择(例如 图像类 → 拍摄美化+图像美化,
  美食类 → 美食+食谱),写入 projects.json 的 `category`/`tag`。

## 第 6 步 — 审核 + 提交

审核人联系方式（姓名/手机/邮箱）通过官方 API 写入 —— `prepare-app-info` 从
`release/appgallery.metadata.json` 的 `reviewContact` 字段读取
（默认值：手机 `13800000000`、邮箱 `review@example.com`、姓名 `开发者`）。
**API 提交不触发短信验证码**（华为官方确认：验证码仅用于 AGC 网页端人工操作）；
仅当 AGC 明确要求人工验证时才用 `contact-verification-ui`：

```
opencli harmony-publish submit-complete --project <key> --confirm-submit true  # 官方 Publishing API；不可撤销——必须先经用户确认
opencli harmony-publish version-inspect --project <key>                        # 校验审核状态
opencli harmony-publish reports-export --project <key> --start YYYYMMDD --end YYYYMMDD # 已上架应用只读分析报表
opencli harmony-publish release-time --project <key> --mode immediate --confirm true # 可选:提交后调整上架时间
```

批量导出后可用 `tools/analyze-reports.py` 汇总前后两个周期，生成
`summary.csv`、`summary.json` 和 `analysis.md`。Reports API 的用户报表提供新增、
活跃与流失指标，但不提供留存率；不得把活跃率写成留存率。Crash/AppFreeze 接口
当前仅支持 API Client 鉴权，不能使用 Service Account JWT。

`contact-verification-ui`（短信验证码）仅在控制台强制人工验证时作为回退：
```
opencli harmony-publish contact-verification-ui --project <key> --stage request --phone ... --email ... --name ...
# 用户收到短信后:
opencli harmony-publish contact-verification-ui --project <key> --stage verify --phone ... --email ... --name ... --code <sms>
```

## 第 7 步 — 发布后收尾：更新项目状态（强制）

**提交审核成功后，必须同步更新仓库根 `项目清单.md` 中的项目状态，缺少状态更新视为发布流程未完成。**

1. **状态列更新**：`submit-complete` 返回 `status: submitted` 后，将该项目在
   `项目清单.md` 对应分类表（HarmonyOS 项目 / Flutter 项目）中的状态列改为
   `✅ 已提交审核`。
2. **信息对齐**：应用名、简介以 `release/appgallery.metadata.json`（appName、
   description）与 `projects.json`（displayName）为准；清单中若为旧名/旧简介，
   同步修正。
3. **备注列补充**：追加提交日期与发布范围，格式参考：
   - `2026-08-12 提交审核（仅中国大陆）`
   - `2026-08-12 已提交审核（全量发布/手机+平板）`
4. **「已上架 / 待发布状态提示」同步**：若该项目有签名发布包
   （`release/signing/*.p7b`），将其加入"存在已签名发布包的项目"列表；
   并检查"当日提交审核"汇总行是否需要补充。
5. **审核通过后**：用户确认审核通过/已上架（`version-inspect` 状态变化或用户
   告知）后，将状态列改为 `✅ 已发布`，并在备注保留提交日期。

注意：仅"已提交审核"不代表已上架；未确认审核结果前不得提前标记为 `✅ 已发布`。

## UI 回退边界与陷阱

只允许 UI 处理：首次创建应用/APP ID、首次创建托管隐私协议（优先 Playwriter
脚本 `tools/privacy-agreement/create-agreement.mjs`，opencli `protocol-draft-ui`
仅作回退）、年龄问卷反馈、短信/验证码/身份或资质确认，以及官方 API 明确返回
不支持的字段。回退命令均应显式使用 `*-ui`；不带该后缀的主流程命令不得启动浏览器。

- 真实应用位于 `#mainIframeView` iframe 内(amp SPA)。必须在 **iframe 窗口内部**
  运行 JS(`contentWindow.eval(...)`),这样 `new Event(...)` 和 `document`
  才属于 iframe;会话 tab 经常重置——每个批次前重新打开 shell URL 并重新
  驱动 iframe。
- Element Plus radio:点击隐藏的 `input` 无效(label 上有 `@click.prevent`);
  应点击 `label` 元素,然后等待 Vue flush 再读取状态。
- 日期选择器单元格忽略普通合成 `click`;需在 iframe 内派发完整事件序列
  `pointerdown → mousedown → mouseup → click`。优先使用默认选项而非日期选择器。
- Vue 状态异步更新:任何点击后都要轮询 DOM(checked class、错误列表、
  输入值),直到出现预期状态。
- AGC 表单数据会持久化在草稿中:页面刷新后字段会重新出现;始终从头校验,
  不要信任先前的状态。
- 单插件多项目共享一个浏览器会话:每个命令必须带 `--project`,命令内部按
  `appId` 导航到对应应用,不要依赖会话内残留的页面状态。
