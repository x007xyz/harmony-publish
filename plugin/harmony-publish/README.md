# harmony-publish OpenCLI plugin

多项目 HarmonyOS 应用发布到华为 AppGallery Connect 的工作流插件。
单份源码,通过 `--project <key>` 区分项目;项目参数统一存于技能目录的
`projects.json`。

## 安装

```bash
opencli plugin install file:///Users/zhangxiangchen/Code/harmony/.agents/skills/harmony-publish/plugin/harmony-publish
```

## 使用

完整流程、命令清单与回退边界见技能主文档
`.agents/skills/harmony-publish/SKILL.md` 与
`references/connect-api.md`。核心命令:

```bash
opencli harmony-publish agc-api --project <key> --action ensure-profile
opencli harmony-publish configure-signing --project <key>
opencli harmony-publish preflight --project <key>
opencli harmony-publish build --project <key>
opencli harmony-publish prepare-app-info --project <key>
opencli harmony-publish upload-package --project <key>
opencli harmony-publish prepare-version-basic --project <key>
opencli harmony-publish complete-screenshots --project <key>
opencli harmony-publish submit-complete --project <key> --confirm-submit true
opencli harmony-publish version-inspect --project <key>
opencli harmony-publish reports-export --project <key> --start YYYYMMDD --end YYYYMMDD
opencli harmony-publish reports-export --app-id <id> --start YYYYMMDD --end YYYYMMDD --output-dir <dir>
```

`--project` 接受 projects.json 的 key、项目绝对路径或 displayName。
默认命令使用官方 Provisioning、Upload Management 和 Publishing API。
UI 回退命令使用 `*-ui` 后缀；只有首次创建 APP ID、首次创建托管隐私协议、
年龄问卷、短信/身份验证或官方 API 明确不支持时才调用。
