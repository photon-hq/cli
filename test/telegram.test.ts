import { describe, expect, test } from 'vitest'
import {
  selectTelegramBotDetail,
  selectTelegramOperationName,
  selectTelegramProvisionInProgress,
  selectTelegramSetupUrl,
  telegramConnectionIssueGuidance
} from '../src/project/telegram.ts'

describe('Telegram setup link', () => {
  test('accepts a t.me link that carries one start parameter', () => {
    expect(
      selectTelegramSetupUrl({
        setupUrl: 'https://t.me/PhotonManagerBot?start=Ab_c-123'
      })
    ).toBe('https://t.me/PhotonManagerBot?start=Ab_c-123')
  })

  test.each([
    ['absent detail', undefined],
    ['no link', {}],
    ['a link that is not text', { setupUrl: 42 }],
    ['another host', { setupUrl: 'https://t.me.example.com/Bot_name?start=a' }],
    ['plain HTTP', { setupUrl: 'http://t.me/PhotonManagerBot?start=a' }],
    ['a port', { setupUrl: 'https://t.me:8443/PhotonManagerBot?start=a' }],
    ['credentials', { setupUrl: 'https://u:p@t.me/PhotonManagerBot?start=a' }],
    ['a fragment', { setupUrl: 'https://t.me/PhotonManagerBot?start=a#x' }],
    ['a deeper path', { setupUrl: 'https://t.me/PhotonManagerBot/1?start=a' }],
    ['a short username', { setupUrl: 'https://t.me/Bot?start=a' }],
    ['no start parameter', { setupUrl: 'https://t.me/PhotonManagerBot' }],
    ['an empty start', { setupUrl: 'https://t.me/PhotonManagerBot?start=' }],
    [
      'two parameters',
      { setupUrl: 'https://t.me/PhotonManagerBot?start=a&b=1' }
    ],
    [
      'a start with other characters',
      {
        setupUrl: 'https://t.me/PhotonManagerBot?start=a%2Fb'
      }
    ],
    ['whitespace', { setupUrl: 'https://t.me/PhotonManagerBot?start=a b' }]
  ])('rejects %s', (_name, detail) => {
    expect(selectTelegramSetupUrl(detail)).toBeUndefined()
  })
})

describe('Telegram bot detail', () => {
  const detail = {
    displayName: 'Alex Support',
    url: 'https://t.me/AlexSupportBot',
    username: 'AlexSupportBot'
  }

  test('reads the name, username and public link', () => {
    expect(selectTelegramBotDetail(detail)).toEqual(detail)
    expect(
      selectTelegramBotDetail({ ...detail, connectionIssue: 'owner_changed' })
    ).toEqual({ ...detail, connectionIssue: 'owner_changed' })
  })

  test('matches the link to the username without regard to case', () => {
    expect(
      selectTelegramBotDetail({ ...detail, url: 'https://t.me/alexsupportbot' })
    ).toMatchObject({ url: 'https://t.me/alexsupportbot' })
  })

  test.each([
    ['no name', { ...detail, displayName: ' ' }],
    ['no username', { ...detail, username: undefined }],
    ['a link to another bot', { ...detail, url: 'https://t.me/OtherBot_1' }],
    ['a link with a query', { ...detail, url: `${detail.url}?start=a` }],
    ['a link to another host', { ...detail, url: 'https://example.com/a' }]
  ])('is absent with %s', (_name, value) => {
    expect(selectTelegramBotDetail(value)).toBeUndefined()
  })

  test('keeps names as the API sent them, for text output to make inert', () => {
    expect(
      selectTelegramBotDetail({ ...detail, displayName: 'A\u001b[2J‮B' })
    ).toMatchObject({ displayName: 'A\u001b[2J‮B' })
    expect(selectTelegramOperationName({ displayName: '\u0007Alex' })).toBe(
      '\u0007Alex'
    )
    expect(selectTelegramOperationName({})).toBeUndefined()
  })
})

describe('Telegram problems', () => {
  test('reads the operation a refused connect names', () => {
    expect(
      selectTelegramProvisionInProgress({
        operationId: 'pho_opr_01h455vb4pex5vsknk084sn02q'
      })
    ).toBe('pho_opr_01h455vb4pex5vsknk084sn02q')
  })

  test.each([
    [undefined],
    ['pho_opr_01h455vb4pex5vsknk084sn02q'],
    [{}],
    [{ operationId: 7 }],
    [{ operationId: 'pho_res_01h455vb4pex5vsknk084sn02q' }],
    [{ operationId: 'pho_opr_01h455vb4pex5vsknk084sn02q/cancel' }]
  ])('ignores %j', (problem) => {
    expect(selectTelegramProvisionInProgress(problem)).toBeUndefined()
  })

  test('explains every connection issue, including one it does not know', () => {
    const issues = [
      'owner_changed',
      'ownership_unverified',
      'management_access_lost',
      'something_new'
    ]
    const guidance = issues.map(telegramConnectionIssueGuidance)

    expect(new Set(guidance).size).toBe(issues.length)
    for (const text of guidance) {
      expect(text.toLowerCase()).toContain('disconnect it')
    }
  })
})
