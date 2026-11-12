import type { CommandRunner } from 'gunshi'
import type { PhotonCommandServices } from '../../../app/services.ts'
import type { OutputTarget } from '../../../core/output.ts'
import { inert } from '../../../core/presenter.ts'
import { resolveOrganizationId } from '../../../organization/command-helpers.ts'
import { paymentDetails } from '../../../organization/presenter.ts'
import type { PhotonCommandParams } from '../../types.ts'
import type { PaymentSetupParams } from './definition.ts'

type PaymentStatusParams = PhotonCommandParams

export const runStatus: CommandRunner<PaymentStatusParams> = async (
  context
) => {
  const { photon } = context.extensions
  const payment = await photon.organizations.getPaymentStatus(
    await resolveOrganizationId(photon)
  )
  photon.output.success(
    payment.response,
    paymentDetails(photon.output, payment)
  )
}

const openCheckout = async (
  photon: PhotonCommandServices,
  checkoutUrl: string
): Promise<boolean> => {
  try {
    await photon.browser.open(checkoutUrl)
    return true
  } catch {
    photon.output.warning(
      'The browser could not be opened. Open the checkout URL manually.'
    )
    return false
  }
}

// The checkout URL is the result, so the document keeps it even when the
// browser opened it. It is a bearer credential, so it stays off stderr, where
// --debug writes its redacted diagnostics. The guide is for the person, so
// JSON mode writes the rest of it to stderr.
export const runSetup: CommandRunner<PaymentSetupParams> = async (context) => {
  const { photon } = context.extensions
  const checkout = await photon.organizations.createPaymentCheckout(
    await resolveOrganizationId(photon)
  )
  const opened =
    !(context.values.noBrowser ?? false) &&
    (await openCheckout(photon, checkout.checkoutUrl))
  if (!opened) {
    photon.output.success(
      { checkout, opened },
      inert(`Checkout URL: ${checkout.checkoutUrl}`)
    )
    return
  }

  const guide = (target: OutputTarget): string =>
    photon.output.style(
      'green',
      'Opened secure payment setup in your browser.',
      target
    )
  if (photon.output.json) {
    photon.output.progress(guide('stderr'))
  }
  photon.output.success({ checkout, opened }, guide('stdout'))
}
