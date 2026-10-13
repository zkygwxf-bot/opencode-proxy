# opencode-proxy

一个运行在 Termux 上的本地代理，为手机客户端提供 OpenAI 兼容接口，接入 OpenCode 模型服务。

## 支持的模型

- mimo-v2.6-flash-free（chat）
- nemotron-3-ultra-free（chat）
- nemotron-3.5-lightning-free（chat）
- big-pickle（chat）
- muse-spark-1.3-contributor-free（responses）
- muse-spark-1.2-contributor-free（responses）

## 安装

v59 测试版

老用户更新命令：

```
rm -rf ~/opencode-proxy && curl -sL -o ~/v59.zip https://github.com/zkygwxf-bot/opencode-proxy/releases/download/v59/opencode-proxy-phone-v59.zip && mkdir -p ~/opencode-proxy && unzip -qo ~/v59.zip -d ~/opencode-proxy && chmod +x ~/opencode-proxy/ai && mkdir -p ~/bin && ln -sf ~/opencode-proxy/ai ~/bin/ai && export PATH="$HOME/bin:$PATH" && ai
```

新用户安装命令：

```
curl -sL -o ~/v59.zip https://github.com/zkygwxf-bot/opencode-proxy/releases/download/v59/opencode-proxy-phone-v59.zip && mkdir -p ~/opencode-proxy && unzip -qo ~/v59.zip -d ~/opencode-proxy && chmod +x ~/opencode-proxy/ai && mkdir -p ~/bin && ln -sf ~/opencode-proxy/ai ~/bin/ai && export PATH="$HOME/bin:$PATH" && ai
```

v58 正式版

老用户更新命令：

```
rm -rf ~/opencode-proxy && curl -sL -o ~/v58.zip https://github.com/zkygwxf-bot/opencode-proxy/releases/download/v58/opencode-proxy-phone-v58.zip && mkdir -p ~/opencode-proxy && unzip -qo ~/v58.zip -d ~/opencode-proxy && chmod +x ~/opencode-proxy/ai && mkdir -p ~/bin && ln -sf ~/opencode-proxy/ai ~/bin/ai && export PATH="$HOME/bin:$PATH" && ai
```

新用户安装命令：

```
curl -sL -o ~/v58.zip https://github.com/zkygwxf-bot/opencode-proxy/releases/download/v58/opencode-proxy-phone-v58.zip && mkdir -p ~/opencode-proxy && unzip -qo ~/v58.zip -d ~/opencode-proxy && chmod +x ~/opencode-proxy/ai && mkdir -p ~/bin && ln -sf ~/opencode-proxy/ai ~/bin/ai && export PATH="$HOME/bin:$PATH" && ai
```

## 使用

安装完成后输入 `ai` 启动。客户端接口地址：`http://127.0.0.1:8788/v1`，Key 任意填写。

模型名加 `-search` 后缀可启用搜索（如 `muse-spark-1.3-contributor-free-search`）。

## 许可证

MIT — 参见 LICENSE。
