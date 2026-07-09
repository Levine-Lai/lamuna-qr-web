# Lamuna 二维码换新版本

这是纯前端静态网页版本，可以部署到 GitHub Pages。网页在浏览器本地完成旧二维码解析、新版本模板匹配、Lamuna 数据重编码、新二维码绘图和下载，不需要 Python 后端。

## 功能

- 批量上传旧版 `ITEM|...|#END` 二维码图片。
- 内置 `26年/标准不带客编` 目录抽取出的 184 个新版本模板。
- 找不到同项目模板时，可手动补充上传同项目新版本二维码。
- 生成 495×400 的新格式二维码图片，左侧项目名和批号按 Lamuna 软件样式居中显示。
- 每张新二维码可单独下载，也可以一键下载 ZIP。
- 生成后会在浏览器里反扫校验，内容一致才标记成功。

## 本地运行

```powershell
npm install
npm run dev
```

打开终端显示的本地地址，例如：

```text
http://127.0.0.1:5173/
```

## 构建

```powershell
npm run build
```

构建输出在 `dist/`。GitHub Pages workflow 会自动构建并发布。

## GitHub Pages

仓库推送到 GitHub 后，`.github/workflows/pages.yml` 会在 `main` 分支更新时自动部署。

如果第一次运行时 GitHub 提示 Pages 未启用，请到仓库：

```text
Settings → Pages → Build and deployment → Source → GitHub Actions
```

然后重新运行 workflow。

## 数据说明

`src/templates.json` 是从本地新版本模板二维码中抽取出来的二维码内容和基础信息。网页不会访问用户电脑上的 `D:\...` 文件夹，因此手机和外部电脑也能使用。

旧二维码图片、生成结果、Excel、日志、软件 DLL/EXE 不应提交到 GitHub。
