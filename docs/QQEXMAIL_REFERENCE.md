# qqexmail 接入说明

核查日期：2026-09-30。用户本机已安装 `qqexmail` 技能，且报告 WorkBuddy 和 QoderWork 已成功读取该邮箱。本次未读取私人凭据，也未实际连接该邮箱。

JobNote 不复制或修改技能源码。它通过 `QQEXMAIL_SKILL_DIR` 定位已安装的技能，并借用技能本地安装的 `imap`、`mailparser` 依赖运行只读收信桥接代码。原因是技能现有交互脚本只返回少量摘要，不能提供分页和逐封机器数据。桥接代码使用同一腾讯企业邮箱 IMAP 地址和授权码，但其真实账号连接仍需联调验证。

所需配置：`QQEXMAIL_SKILL_DIR`、`EXMAIL_ACCOUNT`、`EXMAIL_AUTH_CODE`。收信连接固定 `imap.exmail.qq.com:993`、TLS，`INBOX` 只读打开，按 UID 和日期范围分页。单封 MIME 超过 2 MiB 或正文无法解析会作为失败记录显示，用户可在网页明确跳过或安排下轮重试。首次只检索近 30 天邮件。

原技能包未见独立 LICENSE，公开仓库不包含它的文件、压缩包或衍生副本。用户提供 ZIP 的 SHA-256：`D77B1188CC46AB5864D335012C4A2A7FF93B6A33A281461478EFB7F2EE92ECA7`。
