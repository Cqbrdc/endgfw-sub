# endgfw-sub

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Cqbrdc/endgfw-sub)

定时抓取 **end-gfw 镜像站的免费单节点**，自动跟随镜像地址变化，去重后输出标准订阅。
运行在 Cloudflare Workers 上：**不需要 KV、不需要数据库、不需要任何环境变量**，部署即用。

> 上面的 Deploy 按钮，把 `<你的用户名>` 换成你 fork 后的仓库地址即可一键部署。

## 特性

- **单节点优先**：只抓镜像站 `/api/free` 接口的固定单节点（VLESS-Reality / Hysteria2 / Shadowsocks），
  比订阅里的轮换节点更稳定；全部镜像失败时自动退回官方订阅兜底。
- **镜像自动发现**：镜像站会在 `mirrors` 字段公布新地址，脚本自动跟进，站点换 IP 不用改代码。
- **每 2 小时刷新**：Cron Triggers 定时抓取；请求时只读缓存，不会频繁打源站。
- **零配置存储**：聚合结果放 Cache API（TTL 2 小时），免 KV、免 D1。
- **多客户端**：Hiddify / v2rayN / v2rayNG / Shadowrocket 用混合订阅；Outline 走专用页面逐条导入。

## 部署

### 一键部署

点最上面的 Deploy to Cloudflare 按钮 → 登录 → 授权 → Deploy。
部署完成后到 **Settings → Triggers → Cron Triggers** 确认已有 `0 */2 * * *`（按钮部署通常会带上，没有就手动加）。

### 命令行

```bash
npm install
npx wrangler login
npm run deploy
```

### 手动粘贴

Dashboard → Workers & Pages → Create → Worker → Edit Code → 粘贴 `worker.js` 全部内容 → Deploy，
再手动添加 Cron Trigger `0 */2 * * *`。

## 订阅地址

> 所有地址必须带访问密钥 `?key=1234`（密钥在 `worker.js` 顶部 `CONFIG.accessKey`，部署后请改掉；
> 也可在 Cloudflare 后台 Settings → Variables 里设置 `ACCESS_KEY` 覆盖，优先级更高）。

| 路径 | 用途 |
| --- | --- |
| `/?key=1234` 或 `/sub?key=1234` | 混合订阅（base64）→ Hiddify / v2rayN / v2rayNG / Shadowrocket |
| `/outline?key=1234` | Outline 页面：ss:// 逐条复制 + 二维码（Outline 只认 SS 且不支持订阅链接） |
| `/ss?key=1234` | 仅 Shadowsocks 的订阅 |
| `/plain?key=1234` | 明文节点列表，排查用 |
| `/stats?key=1234` | 节点数、镜像命中情况、更新时间 |
| `/refresh?key=1234` | 手动刷新（可选设置 `REFRESH_TOKEN` 变量后需 `?token=`） |

## 客户端用法速查

| 客户端 | 添加什么 |
| --- | --- |
| Hiddify | 添加订阅 URL：`…workers.dev/sub?key=1234` |
| v2rayN | 订阅分组设置粘贴 `…workers.dev/sub?key=1234` → 更新全部订阅 |
| Outline | 打开 `…workers.dev/outline?key=1234`，逐条复制 ss:// 或扫码 |

详细步骤、排障表见 [部署与使用说明.md](./部署与使用说明.md)。

## 配置

`worker.js` 顶部 `CONFIG` 可按需修改：

```js
const CONFIG = {
  mirrors: ["https://54.255.198.102/", "https://13.212.84.197/"], // 初始镜像，会自动发现新镜像
  apiFree: "/api/free",
  officialSub: "https://raw.githubusercontent.com/hello-world-1989/cn-news/main/end-gfw-free", // 兜底
  maxNodes: 300,
  cacheTtl: 7200, // 2 小时，与 cron 频率一致
};
```

定时频率：改 `wrangler.toml` 的 `crons`（UTC 时间）。

## 安全提醒

- 免费公共节点不可信，站方可看到流量元数据，**不要**用来登录网银、公司邮箱等重要账号。
- Hysteria2 节点带 `insecure=1`（站点自签证书方案），介意者只用 VLESS-Reality 和 SS。
- 免费节点存活期短，客户端订阅自动更新建议 2~4 小时。
- 请遵守当地法律法规，仅用于正常访问资料。

## License

[MIT](./LICENSE)
