# 求职记 · JobNote

把腾讯企业邮箱里的求职邮件整理成一张本机网页，并每 4 小时向微信发送一次待办摘要。

## 能做什么

- 用表格按公司和岗位查看投递、筛选、测评、笔试、AI 面试、一面、二面、三面、Offer 等进展；每条进展保留邮件证据。
- 在岗位表中直接核对或忽略归属不明的进展；另一张表格汇总待办、截止时间和紧急程度，待核对事项也可直接处理。
- 每轮按邮件 UID 分批读取，逐封校验整理结果；失败邮件会挡住进度，直到用户处理。
- 每个 4 小时时段最多向 Server酱 Turbo 提交一份微信摘要，避免重复推送。

首版是**本机单用户工具**。网页仅监听 `127.0.0.1`；数据保存在本机 SQLite。只支持一个腾讯企业邮箱收件箱和微信推送。千问办公负责定时执行及邮件理解。

## 快速开始

需要 Node.js 22.13+、已安装且可用的 [`qqexmail` 技能](docs/QQEXMAIL_REFERENCE.md)，以及千问办公的本地定时任务功能。项目不包含第三方技能源码。

```powershell
git clone https://github.com/wind127/jobnote.git
cd jobnote
npm ci
npm run build
Copy-Item .env.example .env
```

在 `.env` 中填入自己的技能目录、腾讯企业邮箱账号和客户端授权码，以及 Server酱 Turbo SendKey。**不要把 `.env`、邮件正文或 `data/` 提交到 GitHub。**

```powershell
node --env-file=.env dist/cli.js doctor
node --env-file=.env dist/cli.js serve
```

打开 <http://127.0.0.1:3210> 查看真实邮箱数据。`doctor` 检查技能路径与配置格式，不连接邮箱、不显示密钥。若只是体验界面，可运行 `npm run demo` 并打开 <http://127.0.0.1:3211>；该页面只显示虚构示例，并提供返回正式页面的入口。首次整理尚未完成时，正式页面会提示仍有历史邮件待处理。

然后按照 [千问办公任务说明](docs/QWENWORK_TASK.md) 建立**一项每 4 小时**运行的本地定时任务。任务逐批调用 `begin`、`batch`、`submit`、`finish`；只有 `finish` 尝试发送微信摘要。任务中断后可恢复当前批次，不能直接重跑 `finish` 以补发结果不明的消息。

## 开发与文档

```powershell
npm test
npm run check
```

- [SPEC 0.2.0](SPEC.md)：当前实现范围与剩余验收项；其中 0.1.9 设计基线曾通过独立评审。
- [独立评审记录](docs/INDEPENDENT_REVIEW.md)。
- [qqexmail 接入说明](docs/QQEXMAIL_REFERENCE.md)。
- [千问办公任务模板](docs/QWENWORK_TASK.md)。

当前自动化测试覆盖批次完整性、重复提交、单封失败与重试、推送去重及邮箱 UID 重置。已用用户本机授权对真实邮箱完成一次只读抽样读取，结果见[验证记录](docs/VALIDATION.md)。千问办公连续定时运行和微信到达仍待联调；本仓库不含凭据。

## 隐私与许可

JobNote 只把本轮邮件正文暂存在本机待处理批次，提交后清空正文；进展证据和邮件基本信息继续保留以供核对。微信摘要会发送公司、岗位、待办和时间给 Server酱，请先确认你愿意这样处理求职信息。

本项目代码采用 [MIT](LICENSE) 许可。`qqexmail` 是外部安装前置条件，未随项目分发，许可应由其原提供方确认。
