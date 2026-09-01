# AppGallery Connect API 路由

优先调用华为公开的 Connect API。不要把控制台内部接口、浏览器 Cookie 请求或
抓包得到的私有接口称为官方 API。

## 鉴权

- 优先使用开发者级 Service Account；使用 `key_id`、`sub_account`、
  `private_key` 生成 PS256 JWT。
- 通过 `--credential <private.json>` 或环境变量
  `HUAWEI_AGC_SERVICE_ACCOUNT` 提供凭据路径。
- 不要把凭据、JWT、Access Token 或带签名的下载 URL 输出到日志、
  `projects.json` 或 Git。
- 把凭据文件权限设为 `0600`，并保存在仓库外或被忽略的 secrets 目录。

## 官方 API 与回退边界

| 能力 | 首选实现 | 回退 |
|---|---|---|
| 按包名查询 APP ID | Publishing API `GET /publish/v2/appid-list` | 控制台读取 |
| 首次创建应用/APP ID | 官方 API 暂不支持 | `tools/app-id/create-app-id.mjs`（Playwriter 一次性脚本） |
| 发布证书查询/申请 | Provisioning API `/publish/v3/cert*` | UI，仅用于异常恢复 |
| Release Profile 创建/查询/下载 | Provisioning API `/publish/v3/provision*` | UI，仅在 API 权限不可用时 |
| APP、图标、截图上传与关联 | Upload Management + Publishing API | 对应 `*-ui`，仅在接口明确不支持时 |
| 应用基本信息、设备、国家、审核信息 | Publishing API `app-info` | `prepare-app-info-ui` |
| 已上架应用的分发、用户、安装失败分析 | Reports API `harmony-report` | 无；仅导出官方 CSV |
| 多语言文案 | Publishing API `app-language-info` | `prepare-version-basic-ui` |
| 图标/截图关联 | Publishing API `app-file-info` | `complete-screenshots-ui` |
| 年龄分级 | 官方无问卷 API，全部走 UI | `tools/age-rating/submit-rating.mjs`（Playwriter 一次性脚本）；`rating-draft-ui` 仅作回退 |
| 隐私协议更新/提交 | Publishing API `agreement` | 首次创建协议使用 `protocol-draft-ui` |
| 用户协议创建/更新 | Publishing API `agreement` | UI，仅在接口明确不支持时 |
| 提交、状态、提交后上架时间 | Publishing API | 对应 `*-ui`，仅在接口明确不支持时 |
| 本地构建、签名、官方验包 | Hvigor + `hap-sign-tool` | 无 |
| 短信、验证码、资质确认、不可逆提交确认 | 人工参与 | 无 |

## 已接入命令

```bash
opencli harmony-publish agc-api --project <key> --action status
opencli harmony-publish agc-api --project <key> --action resolve-app-id
opencli harmony-publish agc-api --project <key> --action list-certificates
opencli harmony-publish agc-api --project <key> --action ensure-profile
opencli harmony-publish agc-api --project <key> --action download-profile
opencli harmony-publish prepare-app-info --project <key>
opencli harmony-publish app-info-status --project <key>
opencli harmony-publish upload-package --project <key>
opencli harmony-publish prepare-version-basic --project <key>
opencli harmony-publish complete-screenshots --project <key>
opencli harmony-publish screenshot-status --project <key>
opencli harmony-publish set-app-info-phone-only --project <key>
opencli harmony-publish privacy-agreement --project <key> --action update --agreement-id <id> --body-file <agreement.json>
opencli harmony-publish user-agreement --project <key> --action create --body-file <agreement.json>
opencli harmony-publish submit-complete --project <key> --confirm-submit true
opencli harmony-publish version-inspect --project <key>
opencli harmony-publish reports-export --project <key> --start YYYYMMDD --end YYYYMMDD
opencli harmony-publish release-time --project <key> --mode immediate --confirm true
```

`ensure-profile` 必须幂等：先按 `appId + profileName + provisionType=2`
查询，缺失时才创建。默认不传受限 ACL；不得猜测 ACL 名称。

`upload-package` 必须先本地验签并校验 bundle，再调用
`upload-url/for-obs`、上传二进制、`app-package-info`，最后轮询编译状态。
只有官方接口返回明确不支持时才使用 `upload-package-ui`，并记录原因。

`submit-complete` 调用官方 `/publish/v2/app-submit`，仍必须显式传入
`--confirm-submit true`。只有官方接口明确不支持当前发布形态时，才允许改用
`submit-complete-ui`；两者都属于不可逆操作，必须先获得用户确认。

`prepare-app-info` 只接受已经由官方数据确认的 `harmonyChildType` 和
`kindMainTag` 数字 ID，不根据中文 `category`/`tag` 猜测。年龄分级无官方问卷
API（华为明确不做），由 `tools/age-rating/submit-rating.mjs` 在 AGC 网页完成
作答与提交；`rating-draft-ui` 仅作 Playwriter 不可用时的回退。隐私协议 API
只能更新/提交已有协议，首次创建使用 `tools/privacy-agreement/create-agreement.mjs`。

## 官方依据

- Publishing API 指南：
  <https://developer.huawei.com/consumer/cn/doc/App/agc-help-publish-api-guide-0000002271134665>
- Provisioning API 参考：
  <https://developer.huawei.com/consumer/cn/doc/doccenter-submission/agc-help-provision-api-reference-0000002236041494>
- Upload Management API 参考：
  <https://developer.huawei.com/consumer/cn/doc/App/agc-help-upload-api-reference-0000002236041486>
- 服务端授权：
  <https://developer.huawei.com/consumer/cn/doc/App/agc-help-connect-api-obtain-server-auth-0000002271134661>
