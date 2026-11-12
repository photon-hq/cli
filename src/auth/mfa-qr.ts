// qrcode is pinned to 1.5.4. Its public Node entry pulls the PNG filesystem
// renderer into our ESM bundle, so this intentionally uses its internal matrix
// generator. Revalidate this path before upgrading qrcode.
import QRCode from 'qrcode/lib/core/qrcode.js'

export type MfaQrRenderer = (uri: string) => Promise<string> | string

const ANSI_RESET = '\x1b[0m'
const ANSI_QR_COLORS = '\x1b[38;2;0;0;0m\x1b[48;2;255;255;255m'
const QUIET_ZONE_MODULES = 2

const moduleIsDark = (
  modules: Uint8Array,
  size: number,
  x: number,
  y: number
): boolean =>
  x >= 0 && y >= 0 && x < size && y < size && modules[y * size + x] === 1

const modulePair = (upperDark: boolean, lowerDark: boolean): string => {
  if (upperDark) {
    return lowerDark ? '█' : '▀'
  }
  return lowerDark ? '▄' : ' '
}

export const renderTerminalQr: MfaQrRenderer = (uri) => {
  const qrData = QRCode.create(uri, { errorCorrectionLevel: 'L' })
  const { data, size } = qrData.modules
  const lines: string[] = []
  for (let y = -QUIET_ZONE_MODULES; y < size + QUIET_ZONE_MODULES; y += 2) {
    let line = ''
    for (let x = -QUIET_ZONE_MODULES; x < size + QUIET_ZONE_MODULES; x += 1) {
      line += modulePair(
        moduleIsDark(data, size, x, y),
        moduleIsDark(data, size, x, y + 1)
      )
    }
    lines.push(`${ANSI_QR_COLORS}${line}${ANSI_RESET}`)
  }
  return lines.join('\n')
}
