import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  access,
  rm,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

test(
  "卸载仅在用户选择清理且非升级时删除实际数据目录",
  {
    skip: process.platform !== "win32",
  },
  async (t) => {
    const compiler =
      process.env.ARC_RECALL_TEST_MAKENSIS ??
      join(process.env.LOCALAPPDATA, "tauri", "NSIS", "makensis.exe")
    try {
      await access(compiler)
    } catch {
      if (process.env.ARC_RECALL_TEST_MAKENSIS)
        throw new Error("Configured NSIS compiler is unavailable")
      t.skip(
        "NSIS is unavailable; set ARC_RECALL_TEST_MAKENSIS to run the native cleanup test"
      )
      return
    }
    const root = await mkdtemp(join(tmpdir(), "arcrecall-uninstall-test-"))
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
    const template = await readFile("src-tauri/windows/installer.nsi", "utf8")
    const paths = await readFile("crates/arc-recall-core/src/paths.rs", "utf8")
    const dataName = paths.match(/APP_DATA_FOLDER_NAME: &str = "([^"]+)"/)[1]
    // Compile the real uninstall branch with only OS roots/registry operations
    // isolated. No production installer or real user directory is ever executed.
    const cleanup = template
      .slice(
        template.indexOf("  ; Delete app data if the checkbox is selected"),
        template.indexOf("  !ifmacrodef NSIS_HOOK_POSTUNINSTALL")
      )
      .replace(/^\s*DeleteReg.*$/gm, "")
      .replaceAll("$LOCALAPPDATA", "$LocalRoot")
      .replaceAll("$APPDATA", "$RoamingRoot")
    assert.ok(cleanup.includes(`$LocalRoot\\${dataName}`))
    for (const [name, selected, update, removed] of [
      ["selected", 1, 0, true],
      ["retained", 0, 0, false],
      ["upgrade", 1, 1, false],
    ]) {
      const directory = join(root, name)
      const local = join(directory, "Local")
      const roaming = join(directory, "Roaming")
      const bundle = "io.github.zhongyanzhishi.arcrecall"
      const targets = [
        join(local, dataName),
        join(local, bundle),
        join(roaming, bundle),
      ]
      const sibling = join(local, "保留的其他应用")
      for (const target of [...targets, sibling]) {
        await mkdir(target, { recursive: true })
        await writeFile(
          join(target, "fixture.txt"),
          "isolated uninstall fixture"
        )
      }
      const exe = join(directory, "cleanup.exe")
      const source = join(directory, "cleanup.nsi")
      await writeFile(
        source,
        `Unicode true
!include "LogicLib.nsh"
!define BUNDLEID "${bundle}"
Name "Isolated cleanup test"
OutFile "${exe}"
RequestExecutionLevel user
SilentInstall silent
Var LocalRoot
Var RoamingRoot
Var DeleteAppDataCheckboxState
Var UpdateMode
Section
StrCpy $LocalRoot "${local}"
StrCpy $RoamingRoot "${roaming}"
StrCpy $DeleteAppDataCheckboxState ${selected}
StrCpy $UpdateMode ${update}
${cleanup}
SectionEnd
`
      )
      const compiled = spawnSync(compiler, ["/V2", source], {
        windowsHide: true,
        encoding: "utf8",
      })
      assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
      const result = spawnSync(exe, ["/S"], {
        windowsHide: true,
        timeout: 15000,
      })
      assert.equal(result.status, 0, result.error?.message)
      for (const target of targets) {
        if (removed) await assert.rejects(access(target))
        else await access(join(target, "fixture.txt"))
      }
      await access(join(sibling, "fixture.txt"))
    }
  }
)
