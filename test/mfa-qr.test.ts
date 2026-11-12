import { describe, expect, test } from 'vitest'
import { renderTerminalQr } from '../src/auth/mfa-qr.ts'

const ANSI_TRUE_BLACK = '\x1b[38;2;0;0;0m'
const ANSI_TRUE_WHITE_BACKGROUND = '\x1b[48;2;255;255;255m'

describe('MFA terminal QR renderer', () => {
  test('uses compact true-black-on-white modules', async () => {
    const qr = await renderTerminalQr(
      'otpauth://totp/Photon:user@example.test?secret=JBSWY3DPEHPK3PXP&issuer=Photon'
    )

    expect(qr).toContain(ANSI_TRUE_BLACK)
    expect(qr).toContain(ANSI_TRUE_WHITE_BACKGROUND)
    expect(qr).toContain('█')
    expect(qr.split('\n').length).toBeLessThan(24)
  })
})
