export async function mockDictionaryImportSessions(page) {
  await page.evaluate(() => {
    window.dictionaryImportSessions = new Set()
    window.dictionaryImportCalls = []
    const invoke = window.__TAURI_INTERNALS__.invoke
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "dictionary_import_begin") {
        const id = crypto.randomUUID()
        window.dictionaryImportSessions.add(id)
        window.dictionaryImportCalls.push(command)
        return id
      }
      if (command === "dictionary_import_finish") {
        if (!window.dictionaryImportSessions.delete(args.id))
          throw new Error("导入会话不存在。")
        window.dictionaryImportCalls.push(command)
        return
      }
      if (
        command === "dictionary_add" &&
        !window.dictionaryImportSessions.has(args.importId)
      )
        throw new Error("添加候选必须持有导入会话。")
      return invoke(command, args)
    }
  })
}
