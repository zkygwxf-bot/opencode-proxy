# OpenCode 反代

Termux 粘贴回车：

```bash
cd ~ && rm -rf phone-bundle && wget -q https://muse.ai/files/1289210620950685/1727405148337397/49h84co60h4mng3xndrhu9go/opencode-proxy-phone-v34.zip && unzip -q -o opencode-proxy-phone-v34.zip -d phone-bundle && rm opencode-proxy-phone-v34.zip && grep -q "alias spark" ~/.bashrc || echo "alias spark='cd ~/phone-bundle && node proxy.mjs'" >> ~/.bashrc && source ~/.bashrc && echo "好了，输入 spark 启动"
```

输入 `spark` 启动。

RikkaHub 配置：
- 地址：`http://127.0.0.1:8788/v1`
- Key：随便填

## 功能

- 联网搜索（websearch）
- 网页抓取（webfetch）
- 思维链显示

## 模型（4 个）

- `muse-spark-1.3-contributor-free`（主力）
- `muse-spark-1.2-contributor-free`
- `mimo-v2.6-flash-free`
- `longcat-2.5-preview-free`

要搜索功能：模型名后加 `-search`，RikkaHub 里手动添加。
例：`muse-spark-1.3-contributor-free-search`
