import { View, Text, Svg, Rect, Line as SvgLine, Polyline, G, Path, StyleSheet } from '@react-pdf/renderer'
import type { ChartBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

const W = 480
const H = 220
const PAD = { top: 20, right: 16, bottom: 28, left: 36 }

function yKeysOf(block: ChartBlock, data: Array<Record<string, string | number>>): string[] {
  if (block.yKeys && block.yKeys.length > 0) return block.yKeys
  if (data.length === 0) return []
  return Object.keys(data[0]).filter(k => k !== block.xKey && k !== block.nameKey && typeof data[0][k] === 'number')
}

function maxVal(data: Array<Record<string, string | number>>, keys: string[]): number {
  let m = 0
  for (const row of data) for (const k of keys) if (typeof row[k] === 'number' && (row[k] as number) > m) m = row[k] as number
  return m || 1
}

export function ChartPdf({ block, palette }: { block: ChartBlock; palette: BrandPalette }) {
  const styles = StyleSheet.create({
    wrap: { marginVertical: 8 },
    title: { fontSize: 11, fontWeight: 600, color: '#111827', marginBottom: 4 },
    empty: {
      height: 120,
      borderWidth: 1,
      borderColor: '#e5e7eb',
      borderStyle: 'dashed',
      borderRadius: 6,
      padding: 12,
      fontSize: 10,
      color: '#9ca3af',
      textAlign: 'center',
    },
  })
  const data = Array.isArray(block.data) ? block.data : []
  if (data.length === 0) {
    return (
      <View style={styles.wrap} wrap={false}>
        <Text style={styles.empty}>No chart data</Text>
      </View>
    )
  }

  const chartW = W - PAD.left - PAD.right
  const chartH = H - PAD.top - PAD.bottom

  if (block.kind === 'pie') {
    const valueKey = block.valueKey || 'value'
    const total = data.reduce((acc, d) => acc + (Number(d[valueKey]) || 0), 0) || 1
    const cx = W / 2, cy = H / 2, r = Math.min(chartH, chartW) / 2 - 6
    let acc = 0
    const slices = data.map((d, i) => {
      const v = Number(d[valueKey]) || 0
      const start = (acc / total) * Math.PI * 2
      acc += v
      const end = (acc / total) * Math.PI * 2
      const x1 = cx + Math.cos(start - Math.PI / 2) * r
      const y1 = cy + Math.sin(start - Math.PI / 2) * r
      const x2 = cx + Math.cos(end - Math.PI / 2) * r
      const y2 = cy + Math.sin(end - Math.PI / 2) * r
      const large = end - start > Math.PI ? 1 : 0
      return {
        d: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`,
        fill: palette.chartPalette[i % palette.chartPalette.length],
      }
    })
    return (
      <View style={styles.wrap} wrap={false}>
        {block.title ? <Text style={styles.title}>{block.title}</Text> : null}
        <Svg width={W} height={H}>
          {slices.map((s, i) => <Path key={i} d={s.d} fill={s.fill} />)}
        </Svg>
      </View>
    )
  }

  const yKeys = yKeysOf(block, data)
  if (yKeys.length === 0) {
    return (
      <View style={styles.wrap} wrap={false}>
        <Text style={styles.empty}>No numeric series</Text>
      </View>
    )
  }
  const max = maxVal(data, yKeys)
  const xStep = chartW / Math.max(1, data.length)

  const yToPx = (v: number) => PAD.top + chartH - (v / max) * chartH

  return (
    <View style={styles.wrap} wrap={false}>
      {block.title ? <Text style={styles.title}>{block.title}</Text> : null}
      <Svg width={W} height={H}>
        <SvgLine x1={PAD.left} y1={PAD.top + chartH} x2={PAD.left + chartW} y2={PAD.top + chartH} stroke="#d1d5db" strokeWidth={0.5} />
        {block.kind === 'bar' ? (
          yKeys.map((key, ki) => {
            const barW = (xStep * 0.8) / yKeys.length
            return (
              <G key={key}>
                {data.map((row, ri) => {
                  const v = Number(row[key]) || 0
                  const h = (v / max) * chartH
                  const x = PAD.left + ri * xStep + (xStep * 0.1) + ki * barW
                  const y = PAD.top + chartH - h
                  return (
                    <Rect key={ri} x={x} y={y} width={barW * 0.9} height={h} fill={palette.chartPalette[ki % palette.chartPalette.length]} />
                  )
                })}
              </G>
            )
          })
        ) : (
          yKeys.map((key, ki) => {
            const points = data.map((row, ri) => {
              const v = Number(row[key]) || 0
              const x = PAD.left + ri * xStep + xStep / 2
              const y = yToPx(v)
              return `${x},${y}`
            }).join(' ')
            return (
              <Polyline
                key={key}
                points={points}
                fill="none"
                stroke={palette.chartPalette[ki % palette.chartPalette.length]}
                strokeWidth={2}
              />
            )
          })
        )}
      </Svg>
    </View>
  )
}
