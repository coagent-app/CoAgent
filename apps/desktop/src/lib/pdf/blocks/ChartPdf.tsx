import { View, Text, Svg, Rect, Line as SvgLine, Polyline, G, Path, StyleSheet } from '@react-pdf/renderer'
import type { ChartBlock } from '@coagent/shared'
import type { BrandPalette } from '../theme'

const W = 480
const H = 220
// Bottom padding is increased to leave room for X-axis labels drawn inside
// the SVG just below the baseline.
const PAD = { top: 20, right: 16, bottom: 28, left: 36 }

// Extra vertical space added as React-PDF Views below the SVG.
const X_LABEL_H = 16  // row of category labels (bar/line)
const LEGEND_H  = 20  // legend row (multi-series bar/line, or pie)

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

/** Format a number compactly: 1 500 000 → 1.5M, 2 300 → 2.3K, else as-is */
function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
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
    // X-axis label row — each label is absolutely positioned over its bar group
    xLabelRow: {
      position: 'relative',
      height: X_LABEL_H,
      width: W,
    },
    // Horizontal legend row below the chart area
    legendRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
      marginTop: 4,
      paddingLeft: PAD.left,
    },
    legendItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    legendSwatch: {
      width: 8,
      height: 8,
      borderRadius: 2,
    },
    legendLabel: {
      fontSize: 8,
      color: '#374151',
    },
    // Pie legend (vertical, right of pie)
    pieLegendWrap: {
      flexDirection: 'row',
      alignItems: 'flex-start',
    },
    pieLegendItems: {
      flexDirection: 'column',
      gap: 6,
      paddingTop: 8,
      paddingLeft: 8,
      justifyContent: 'center',
      flex: 1,
    },
    pieLegendItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    pieLegendSwatch: {
      width: 8,
      height: 8,
      borderRadius: 2,
    },
    pieLegendText: {
      fontSize: 8,
      color: '#374151',
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

  // ── Pie chart ───────────────────────────────────────────────────────────
  if (block.kind === 'pie') {
    const nameKey  = block.nameKey  || 'name'
    const valueKey = block.valueKey || 'value'
    const total = data.reduce((acc, d) => acc + (Number(d[valueKey]) || 0), 0) || 1

    // Pie is drawn in the left ~60% of W so the right side holds the legend.
    const PIE_W = Math.round(W * 0.55)
    const cx = PIE_W / 2
    const cy = H / 2
    const r  = Math.min(H, PIE_W) / 2 - 10

    let acc = 0
    const slices = data.map((d, i) => {
      const v     = Number(d[valueKey]) || 0
      const start = (acc / total) * Math.PI * 2
      acc += v
      const end   = (acc / total) * Math.PI * 2
      const x1 = cx + Math.cos(start - Math.PI / 2) * r
      const y1 = cy + Math.sin(start - Math.PI / 2) * r
      const x2 = cx + Math.cos(end   - Math.PI / 2) * r
      const y2 = cy + Math.sin(end   - Math.PI / 2) * r
      const large = end - start > Math.PI ? 1 : 0
      return {
        path:  `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`,
        fill:  palette.chartPalette[i % palette.chartPalette.length],
        label: String(d[nameKey] ?? ''),
        value: fmtNum(Number(d[valueKey]) || 0),
      }
    })

    return (
      <View style={styles.wrap} wrap={false}>
        {block.title ? <Text style={styles.title}>{block.title}</Text> : null}
        <View style={styles.pieLegendWrap}>
          <Svg width={PIE_W} height={H}>
            {slices.map((s, i) => <Path key={i} d={s.path} fill={s.fill} />)}
          </Svg>
          {/* Right-side legend */}
          <View style={styles.pieLegendItems}>
            {slices.map((s, i) => (
              <View key={i} style={styles.pieLegendItem}>
                <View style={[styles.pieLegendSwatch, { backgroundColor: s.fill }]} />
                <Text style={styles.pieLegendText}>{s.label} — {s.value}</Text>
              </View>
            ))}
          </View>
        </View>
      </View>
    )
  }

  // ── Bar / Line chart ────────────────────────────────────────────────────
  const yKeys   = yKeysOf(block, data)
  if (yKeys.length === 0) {
    return (
      <View style={styles.wrap} wrap={false}>
        <Text style={styles.empty}>No numeric series</Text>
      </View>
    )
  }

  const max   = maxVal(data, yKeys)
  const xStep = chartW / Math.max(1, data.length)
  const xKey  = block.xKey || 'name'

  const yToPx = (v: number) => PAD.top + chartH - (v / max) * chartH

  // X-axis label positions: center of each group
  const xLabelPositions = data.map((row, ri) => ({
    label: String(row[xKey] ?? ''),
    cx:    PAD.left + ri * xStep + xStep / 2,
  }))

  const showLegend = yKeys.length > 1

  return (
    <View style={styles.wrap} wrap={false}>
      {block.title ? <Text style={styles.title}>{block.title}</Text> : null}
      <Svg width={W} height={H}>
        {/* Y-axis baseline */}
        <SvgLine
          x1={PAD.left} y1={PAD.top + chartH}
          x2={PAD.left + chartW} y2={PAD.top + chartH}
          stroke="#d1d5db" strokeWidth={0.5}
        />
        {/* Y-axis max label (top-left) */}
        <SvgLine
          x1={PAD.left - 4} y1={PAD.top}
          x2={PAD.left} y2={PAD.top}
          stroke="#d1d5db" strokeWidth={0.5}
        />
        {/* Y tick labels — max at top, zero at baseline */}
        <G>
          {/* max value */}
          <Path
            d=""
            fill={palette.neutral}
            // react-pdf SVG doesn't support <text> natively — we use absolute
            // positioned Text in the wrapping View for axis labels instead.
          />
        </G>

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
                    <Rect
                      key={ri}
                      x={x} y={y}
                      width={barW * 0.9} height={Math.max(h, 0)}
                      fill={palette.chartPalette[ki % palette.chartPalette.length]}
                    />
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

      {/* ── X-axis category labels (below SVG) ── */}
      <View style={styles.xLabelRow}>
        {xLabelPositions.map(({ label, cx }, i) => (
          <Text
            key={i}
            style={{
              position: 'absolute',
              fontSize: 7,
              color: palette.neutral,
              left: cx - 24,   // rough centering; 48pt wide text box
              width: 48,
              textAlign: 'center',
              top: 2,
            }}
          >
            {label}
          </Text>
        ))}
        {/* Y-axis labels overlaid at left edge */}
        <Text
          style={{
            position: 'absolute',
            fontSize: 7,
            color: palette.neutral,
            left: 0,
            width: PAD.left - 2,
            textAlign: 'right',
            // Align with the top of the SVG chart area (PAD.top) — but this
            // View starts right after the SVG, so we use a negative top to
            // pull it up visually. react-pdf absolute positioning is relative
            // to this View; we need these labels AT the SVG level, so we embed
            // them in the SVG-height zone. Use top: -(H - 4) instead.
            top: -(H - PAD.top + 2),
          }}
        >
          {fmtNum(max)}
        </Text>
        <Text
          style={{
            position: 'absolute',
            fontSize: 7,
            color: palette.neutral,
            left: 0,
            width: PAD.left - 2,
            textAlign: 'right',
            top: -(PAD.bottom - 2),
          }}
        >
          0
        </Text>
      </View>

      {/* ── Multi-series legend ── */}
      {showLegend && (
        <View style={styles.legendRow}>
          {yKeys.map((key, ki) => (
            <View key={key} style={styles.legendItem}>
              <View style={[styles.legendSwatch, { backgroundColor: palette.chartPalette[ki % palette.chartPalette.length] }]} />
              <Text style={styles.legendLabel}>{key}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}
