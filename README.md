# 天元之奕 · 补位推荐

一个基于 Node.js 原生 HTTP 服务的天元之奕补位推荐 WebUI。

## 本地运行

需要 Node.js 18 或更高版本。

```bash
npm start
```

打开 <http://127.0.0.1:8787>。

## 局域网访问

```bash
HOST=0.0.0.0 PORT=8787 npm start
```

## 数据

项目默认使用 `data/snapshot.json` 快照，也可以在页面中刷新数据或执行：

```bash
npm run fetch
```

数据来源：<https://tianyuanzhiyi.com>。仅供个人查询参考，请勿商用。
