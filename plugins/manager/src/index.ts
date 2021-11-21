import { Context, Schema } from 'koishi'
import { resolve } from 'path'
import { BotProvider } from './bots'
import { MarketProvider } from './market'
import { PackageProvider } from './packages'
import { AdapterProvider } from './protocols'
import { RegistryProvider } from './registry'
import { ReleaseProvider } from './releases'

export * from './bots'
export * from './market'
export * from './packages'
export * from './protocols'
export * from './registry'
export * from './releases'

declare module 'koishi' {
  interface Modules {
    manager: typeof import('.')
  }
}

export const name = 'manager'

export interface Config extends MarketProvider.Config {}

export const Config = Schema.intersect([
  MarketProvider.Config,
])

export function apply(ctx: Context, config: Config = {}) {
  ctx.with(['console'], (ctx) => {
    ctx.plugin(BotProvider)
    ctx.plugin(MarketProvider, config)
    ctx.plugin(AdapterProvider)
    ctx.plugin(PackageProvider)
    ctx.plugin(RegistryProvider)
    ctx.plugin(ReleaseProvider)

    const filename = ctx.console.config.devMode ? '../client/index.ts' : '../dist/index.js'
    ctx.console.addEntry(resolve(__dirname, filename))

    ctx.console.addListener('install', async function ({ name }) {
      if (await this.validate()) return this.send('unauthorized')
      ctx.console.sources.market.install(name)
    })

    ctx.console.addListener('switch', async function ({ name }) {
      if (await this.validate()) return this.send('unauthorized')
      ctx.console.sources.registry.switch(name)
    })

    for (const event of ['install', 'dispose', 'reload', 'save'] as const) {
      ctx.console.addListener(`plugin/${event}`, async function ({ name, config }) {
        if (await this.validate()) return this.send('unauthorized')
        this.app.emit(`config/plugin-${event}`, name, config)
      })
    }

    ctx.console.addListener('bot/create', async function ({ platform, protocol, config }) {
      if (await this.validate()) return this.send('unauthorized')
      this.app.emit('config/bot-create', platform, { protocol, ...config })
    })

    for (const event of ['remove', 'start', 'stop'] as const) {
      ctx.console.addListener(`bot/${event}`, async function ({ id }) {
        if (await this.validate()) return this.send('unauthorized')
        this.app.emit(`config/bot-${event}`, id)
      })
    }
  })
}
