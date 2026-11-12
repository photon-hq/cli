/**
 * A Photon credential-shaped test value, `pho_<kind>_<rest>`. The public
 * export's secret scan and content check read such a literal as a credential,
 * so tests build these values at run time instead of writing them out.
 */
export const photonKey = (kind: 'ask' | 'cs' | 'sk', rest: string): string =>
  `pho_${kind}_${rest}`
