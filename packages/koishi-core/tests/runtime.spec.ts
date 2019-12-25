import { CLIENT_PORT, createServer, SERVER_URL, ServerSession } from 'koishi-test-utils'
import { App } from 'koishi-core/src'

const app = new App({
  type: 'http',
  port: CLIENT_PORT,
  server: SERVER_URL,
})

const server = createServer()

jest.setTimeout(1000)

beforeAll(() => app.start())

afterAll(() => {
  app.stop()
  server.close()
})

app.command('foo [text]')
  .action(({ meta }, bar) => {
    return meta.$send('foo' + bar)
  })

app.command('fooo [text]')
  .action(({ meta }, bar) => {
    return meta.$send('fooo' + bar)
  })

const session1 = new ServerSession('private', 'friend', { selfId: 123, userId: 456 })
const session2 = new ServerSession('private', 'friend', { selfId: 123, userId: 789 })

describe('suggestions', () => {
  test('execute command', async () => {
    await session1.testSnapshot('foo bar')
    await session1.shouldHaveNoResponse(' ')
  })

  test('no suggestions found', async () => {
    await session1.shouldHaveNoResponse('bar foo')
  })

  test('apply suggestions', async () => {
    await session1.testSnapshot('fo bar')
    await session2.waitForResponse('fooo bar')
    await session1.testSnapshot(' ')
    await session1.shouldHaveNoResponse(' ')
  })

  test('ignore suggestions 1', async () => {
    await session1.testSnapshot('fo bar')
    await session1.shouldHaveNoResponse('bar foo')
    await session1.shouldHaveNoResponse(' ')
  })

  test('ignore suggestions 2', async () => {
    await session1.testSnapshot('fo bar')
    await session1.waitForResponse('foo bar')
    await session1.shouldHaveNoResponse(' ')
  })

  test('multiple suggestions', async () => {
    await session1.testSnapshot('fool bar')
    await session1.shouldHaveNoResponse(' ')
  })
})
