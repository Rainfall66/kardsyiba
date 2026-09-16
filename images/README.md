# images/ —— 卡图目录

此目录存放**卡图**(AVIF),默认是空的。**游戏本体不依赖卡图**,没有图也能正常游玩。

放进去之后游戏会自动启用两个功能:**结算弹窗显示答案卡图**,以及**鼠标悬停卡名时的卡图预览**。
任何一次加载失败都会把这两个功能静默关掉,所以缺图既不会显示裂图,也不会反复刷 404。

## 目录约定

- 文件名 = 卡牌数据里每张卡的 `image` 字段(如 `13e_dragons.avif`),**不要改名**;
- 想换图:把同名文件放进本目录覆盖即可,无需改代码;
- 体积参考:AVIF 单张约 10~60 KB,全量约 40~80 MB;
- 版权归游戏官方(1939 Games)所有,仅作粉丝向非商业交流使用。

## 怎么下载

下载脚本在**数据流水线**目录 `../kardsyiba-pipeline/`(不随本仓库发布):

```bash
cd ../kardsyiba-pipeline

# 1) 先取官方当前 CDN 版本号(需代理,几秒)
$env:HTTPS_PROXY='http://127.0.0.1:7897'; $env:NODE_USE_ENV_PROXY='1'
node fetch_image_index.js

# 2) 下载游戏卡库需要的 1590 张 AVIF
node fetch_images.js

# 只试跑 20 张 / 校验已下载的文件(校验不联网)
node fetch_images.js --limit 20
node fetch_images.js --verify
```

图片会落到本目录,下载清单写在流水线的 `images-manifest.json`。

图片 URL 形如:

```
https://www.kards.com/images/card/<版本>/<语言>/<image>
例:https://www.kards.com/images/card/v53/zh-Hans/13e_dragons.avif
```

- `<版本>` **不要写死**:接口的 `node.image` 字段会给当前版本(实测 v52 → v53);
  `fetch_image_index.js` 就是去取这个值的,没有它脚本只能用兜底版本并警告。
- `<语言>` 取 `zh-Hans`(中文)或 `en-EN`(英文)。接口给的路径**恒为 `en-EN`**,
  改 `Accept-Language` 无效,所以中文图是脚本自己替换语言段拼出来的。

> 卡图**不纳入版本控制**(见 `../.gitignore`):全量约 40~80 MB,而游戏本体不依赖卡图。
> 版权归游戏官方(1939 Games)所有,仅作粉丝向非商业交流使用。
