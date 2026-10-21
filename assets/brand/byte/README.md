# 字节流主题 Logo

沿用 `../arch-key/` 的拱门与钥匙孔轮廓，使用小尺寸版放大的孔径与圆点。

- 应用图标：深蓝黑 `#081117` 底、冷白 `#d9eef0` 主体、青绿 `#3fe3c6` 圆点。
- 页头：无底板，主体跟随 `foreground`，圆点跟随 `primary`，搭配现有 `ARCRECALL` 等宽字标。
- 页头的 SVG 位于 `src/components/redesign/workbench-header.tsx`，修改轮廓时需与本目录源图同步。
- 原始橙色方案保留在 `../arch-key/`。

重新生成桌面图标：

```powershell
pnpm exec tauri icon assets/brand/byte/arc-recall-app-icon.svg --output artifacts/brand-icons
Get-ChildItem src-tauri/icons -File | ForEach-Object { Copy-Item -LiteralPath (Join-Path artifacts/brand-icons $_.Name) -Destination $_.FullName }
Copy-Item artifacts/brand-icons/icon.ico src/app/favicon.ico
```

只复制桌面项目已使用的图标文件，生成目录中的移动端图标不接入本项目。
