# Key 通路报告（真 key 路线）

> 日期：2026-10-13 12:36。用户决定自己去 opencode.ai/auth 注册拿 key。

## 一、代码确认

1. **getApiKey()**（proxy.mjs:346）：优先级 `OPENCODE_API_KEY` > `OPENCODE_ZEN_API_KEY` > `~/.config/opencode-proxy/key` 文件 > `"public"`。本次新增文件读取（600 权限）。
2. **Authorization 透传**（proxy.mjs:3618）：`authorization: \`Bearer ${apiKey}\``，每次上游请求都带。实测三档：文件 OK、环境变量优先 OK、无 key 回退 "public" OK。
3. **不泄露**：/health 不返回 key；启动日志只显示"免费模式"/"已检测到 API Key"，不打印 key 值；.gitignore 已加 `key` 规则；key 文件在 ~/.config（仓库外）。

## 二、用户配 key 的一行命令（Termux）

```bash
mkdir -p ~/.config/opencode-proxy && echo '把你的key粘在这里' > ~/.config/opencode-proxy/key && chmod 600 ~/.config/opencode-proxy/key
```

然后重启反代（`spark` 脚本会自动读到）。验证：启动日志显示"已检测到 API Key（付费模型可用）"即成功。

## 三、有真 key 后哪些伪装还要（待用户拿到 key 后实测）

推理（需实测验证）：
- **Authorization: Bearer 真 key**：必须有，这是付费身份。
- **identityHeaders（UA/x-opencode-*）**：建议保留，无害，且上游可能仍做客户端校验。
- **read/shell 伪装工具注入**：免费层 403 的主因是"非 OpenCode 客户端"判定；有真 key 后理论上不需要，但保留也无害（上游忽略不认的工具）。建议先保留，实测去掉后若正常再省。
- **session.json**：免费匿名模式的会话伪装；有真 key 后可能不再需要，但 identityHeaders 仍引用它的字段。建议保留文件，实测。

实测方法（key 到手后）：逐个去掉可疑头/注入，用付费模型发一次请求，看是否 200。先从"全保留"开始，逐个做减法。

## 四、注意事项

- 绝不把 key 写进 git、zip、日志、报告。本报告不含任何 key。
- key 文件权限必须 600，防同机其他用户读取。
