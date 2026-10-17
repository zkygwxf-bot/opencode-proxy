# opencode-proxy

一个运行在 Termux 上的本地代理，为手机客户端提供 OpenAI 兼容接口，接入 OpenCode 模型服务。

## 支持的模型

- deepseek-v4.1-flash-free（chat）
- glm-5.3-flash-free（chat）
- mimo-v2.6-flash-free（chat）
- nemotron-3.5-lightning-free（chat）
- nemotron-3.5-super-vl-free（chat）
- big-pickle（chat）
- beam-free（chat）
- longcat-2.5-preview-free（chat）
- space-bunny-free（chat）
- muse-spark-1.2-contributor-free（responses）

## 安装

v63

老用户更新命令：

```
rm -rf ~/opencode-proxy && curl -sL -o ~/v63.zip https://github.com/zkygwxf-bot/opencode-proxy/releases/download/v63/opencode-proxy-phone-v63.zip && mkdir -p ~/opencode-proxy && unzip -qo ~/v63.zip -d ~/opencode-proxy && chmod +x ~/opencode-proxy/ai && ln -sf ~/opencode-proxy/ai $PREFIX/bin/ai && ai
```

新用户安装命令：

```
curl -sL -o ~/v63.zip https://github.com/zkygwxf-bot/opencode-proxy/releases/download/v63/opencode-proxy-phone-v63.zip && mkdir -p ~/opencode-proxy && unzip -qo ~/v63.zip -d ~/opencode-proxy && chmod +x ~/opencode-proxy/ai && ln -sf ~/opencode-proxy/ai $PREFIX/bin/ai && ai
```

## 使用

安装完成后输入 `ai` 启动。客户端接口地址：`http://127.0.0.1:8788/v1`，Key 任意填写。

模型名加 `-search` 后缀可启用搜索（如 `muse-spark-1.2-contributor-free-search`）。

## 许可证

MIT — 参见 LICENSE。
