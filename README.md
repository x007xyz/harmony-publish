# harmony-publish

API-first HarmonyOS 应用发布技能：把 HarmonyOS / Flutter(ohos) 项目端到端发布到华为 AppGallery Connect (AGC)。

覆盖完整发布流程：项目注册与配置、AGC APP ID + Release Profile + 签名、带官方校验的 release 构建、商店截图、应用信息（分类/标签/图标）、版本草稿（国家/文案/截图/年龄分级/隐私托管/联系方式）以及最终提交。优先使用华为官方 Provisioning、Upload Management 与 Publishing API；仅对未开放接口、人工验证和首次配置使用 AGC 控制台自动化。

## 安装

```bash
npx skills add x007xyz/harmony-publish
```

或作为 OpenCLI 插件安装：

```bash
opencli plugin install file://<skill>/plugin/harmony-publish
```

## 前置条件

- 华为开发者账号 + AGC 项目
- 开发者级 AGC Service Account：创建 `secrets/private.json`（不随仓库分发），通过 `--credential` 传入，或设置 `HUAWEI_AGC_SERVICE_ACCOUNT` 环境变量
- 共享 release 签名证书：`certs/release.p12` + `release.cer`（含同目录 `material/` 解密材料）
- DevEco Studio 工具链（hvigorw、ohpm、hap-sign-tool）
- 已登录 developer.huawei.com 的 Chrome（Playwriter 扩展，用于 UI 回退路径）

## 配置

1. 复制 `projects.json` 模板，把 `<HARMONY_ROOT>` 替换为本机项目根目录，按需增删项目条目
2. 每个项目根目录准备 `release/appgallery.metadata.json`（应用信息/截图/审核人联系方式）
3. 审核人联系方式默认值见 `references/presets.md`，按需覆盖

## 使用

```bash
opencli harmony-publish agc-api --project <key> --action status
opencli harmony-publish preflight --project <key> --metadata release/appgallery.metadata.json
opencli harmony-publish build --project <key>
opencli harmony-publish submit-complete --project <key> --confirm-submit true
```

完整流程见 [SKILL.md](SKILL.md)。

## 安全说明

- `secrets/`、`certs/` 不随仓库分发，请自行创建/放置
- `projects.json` 中的项目路径使用 `<HARMONY_ROOT>` 占位符，按本机环境填写
- 审核人联系方式为占位符，发布前按实际信息覆盖
