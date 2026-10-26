import {
  EMPTY_SUMMARY,
  type DictionaryImportOptions,
  type DictionaryTextEncoding,
} from "./dictionary-model.ts"

export async function detectDictionaryEncoding(
  file: Blob,
  options: DictionaryImportOptions = {}
): Promise<DictionaryTextEncoding> {
  options.signal?.throwIfAborted()
  const sample = new Uint8Array(await file.slice(0, 3).arrayBuffer())
  let declaredEncoding: DictionaryTextEncoding | undefined
  if (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    declaredEncoding = "utf-8"
  }
  if (sample[0] === 0xff && sample[1] === 0xfe) {
    declaredEncoding = "utf-16le"
  }
  if (sample[0] === 0xfe && sample[1] === 0xff) {
    declaredEncoding = "utf-16be"
  }
  // Validate before the first IPC batch so a late encoding error cannot leave
  // a partially imported dictionary. Blob slices keep the preflight bounded.
  const encodings: DictionaryTextEncoding[] = declaredEncoding
    ? [declaredEncoding]
    : ["utf-8", "gb18030"]
  for (const encoding of encodings) {
    if (await canDecodeDictionary(file, encoding, options)) return encoding
  }
  throw new Error(
    "字典包含无效的文本编码，请转换为 UTF-8 后重试；尚未导入任何候选。"
  )
}

async function canDecodeDictionary(
  file: Blob,
  encoding: DictionaryTextEncoding,
  options: DictionaryImportOptions
): Promise<boolean> {
  const decoder = new TextDecoder(encoding, { fatal: true })
  const chunkBytes = 64 * 1024
  options.onProgress?.({
    phase: "validating",
    processedBytes: 0,
    totalBytes: file.size,
    encoding,
    summary: EMPTY_SUMMARY,
  })
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    options.signal?.throwIfAborted()
    const bytes = await file.slice(offset, offset + chunkBytes).arrayBuffer()
    options.signal?.throwIfAborted()
    try {
      decoder.decode(bytes, { stream: true })
    } catch {
      return false
    }
    options.onProgress?.({
      phase: "validating",
      processedBytes: Math.min(offset + chunkBytes, file.size),
      totalBytes: file.size,
      encoding,
      summary: EMPTY_SUMMARY,
    })
    if ((offset / chunkBytes + 1) % 16 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  options.signal?.throwIfAborted()
  try {
    decoder.decode()
    return true
  } catch {
    return false
  }
}
