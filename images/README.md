# images/ —— 卡图目录(预留)

此目录为**卡图预留目录**,默认是空的。**游戏本体不依赖卡图**,没有图也能正常游玩。

## 目录约定

- 文件名 = 卡牌数据里每张卡的 `image` 字段(如 `13e_dragons.avif`),**不要改名**;
- 想换图:把同名文件放进本目录覆盖即可,无需改代码;
- 体积参考:AVIF 单张约 10~60 KB,全量约 40~80 MB;
- 版权归游戏官方(1939 Games)所有,仅作粉丝向非商业交流使用。

## 怎么下载

下载脚本在**数据流水线**目录 `../kardsyiba-pipeline/`(不随本仓库发布):

```bash
cd ../kardsyiba-pipeline

# 全量下载(约 1600 张 AVIF;国内需挂代理)
HTTPS_PROXY=http://127.0.0.1:7897 NODE_USE_ENV_PROXY=1 node fetch_images.js

# 只下现役卡池 / 只试跑 20 张
node fetch_images.js --pool active
node fetch_images.js --limit 20
```

图片会落到本目录,下载清单写在流水线的 `images-manifest.json`。

图片 URL 模板(实测可达):

```
https://www.kards.com/images/card/v52/zh-Hans/<image>
```

`<image>` 即卡牌的 `image` 字段;完整 URL 也已预先算在整合卡库的 `imageUrl` 字段里。
把语言段 `zh-Hans` 换成 `en-EN` 即英文卡图。
