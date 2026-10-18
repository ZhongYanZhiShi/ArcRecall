<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

## 测试命名与夹具

- 测试用例名称描述被验证的行为、场景或预期结果，不使用用户原始文件或文件夹的名称。
- 测试中的文件和文件夹使用与测试场景相关的通用名称，如 `加密归档.dll`、`嵌套归档.zip`、`[测试分组] 中文目录`，不照搬用户的真实名称或路径。
- 复现路径兼容问题时，在通用夹具名称中保留必要的触发条件（如中文、空格、方括号、伪装后缀），并使用临时目录。
