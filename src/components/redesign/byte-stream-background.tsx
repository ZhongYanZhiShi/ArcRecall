// Decorative bytes are deterministic so the first client frame matches the HTML.
const COLUMNS = Array.from({ length: 16 }, (_, column) => {
  let seed = 29 + column * 71
  const bytes = Array.from({ length: 82 }, () => {
    seed = (seed * 9301 + 49297) % 233280
    return Math.floor((seed / 233280) * 256)
      .toString(16)
      .toUpperCase()
      .padStart(2, "0")
  }).join("\n")
  return { bytes, duration: 18 + (column % 7) * 2, delay: -(column % 9) * 3 }
})

export function ByteStreamBackground() {
  return (
    <div className="byte-stream" aria-hidden="true">
      {COLUMNS.map((column, index) => (
        <span
          key={index}
          style={{
            left: `${index * 30}px`,
            animationDuration: `${column.duration}s`,
            animationDelay: `${column.delay}s`,
          }}
        >
          {column.bytes}
        </span>
      ))}
    </div>
  )
}
