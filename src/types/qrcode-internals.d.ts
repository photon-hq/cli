declare module 'qrcode/lib/core/qrcode.js' {
  export interface QrCodeData {
    modules: {
      data: Uint8Array
      size: number
    }
  }

  const qrCode: {
    create: (
      value: string,
      options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }
    ) => QrCodeData
  }

  export default qrCode
}
