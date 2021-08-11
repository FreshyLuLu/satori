import { Logger, defineProperty, remove, segment, Random } from '@koishijs/utils'
import { Command } from './command'
import { Session } from './session'
import { User, Channel, Database, Assets, Cache } from './database'
import { Argv } from './parser'
import { Platform, Bot } from './adapter'
import { App } from './app'

export type NextFunction = (next?: NextFunction) => Promise<void>
export type Middleware = (session: Session, next: NextFunction) => any
export type Promisify<T> = T extends Promise<unknown> ? T : Promise<T>
export type Awaitable<T> = T extends Promise<unknown> ? T : T | Promise<T>
export type Await<T> = T extends Promise<infer U> ? U : T
export type Disposable = () => void

export type MethodDecorator<T = (...args: any[]) => any>
  = (target: Object, key: string | symbol, desc: TypedPropertyDescriptor<T>)
    => void | TypedPropertyDescriptor<T>

export const Middleware: (prepend?: boolean) => MethodDecorator = (prepend) => (target, prop, desc) => {
  Plugin.meta.ensure(target).set(desc.value, function () {
    this.middleware(desc.value.bind(this), prepend)
  })
}

export const Apply: MethodDecorator = (target, prop, desc) => {
  Plugin.meta.ensure(target).set(desc.value, function () {
    desc.value.call(this)
  })
}

type EventDecorator<T> = <E extends keyof T>(name: E, xpend?: boolean) => MethodDecorator

export const Event: EventDecorator<EventMap> = (name, prepend) => (target, prop, desc) => {
  Plugin.meta.ensure(target).set(desc.value, function () {
    this.on(name, desc.value.bind(this), prepend)
  })
}

export const BeforeEvent: EventDecorator<BeforeEventMap> = (name, append) => (target, prop, desc) => {
  Plugin.meta.ensure(target).set(desc.value, function () {
    this.before(name, desc.value.bind(this), append)
  })
}

export class Metadata<K extends object, V> extends WeakMap<K, V> {
  constructor(private fallback: () => V) {
    super()
  }

  ensure(key: K) {
    if (!this.has(key)) this.set(key, this.fallback())
    return this.get(key)
  }
}

export class Plugin<T> {
  static meta = new Metadata(() => new Map<Function, (this: Context) => void>())

  constructor(protected context: Context, public config: T) {
    const callbacks = Plugin.meta.get(Object.getPrototypeOf(this))
    callbacks?.forEach(cb => cb.call(context))
  }
}

export namespace Plugin {
  export type Apply<T = any> = (ctx: Context, options: T) => void
  export type Construct<T = any> = new (ctx: Context, options: T) => void
  export type Function<T = any> = Apply<T> | Construct<T>
  export type Entry<T = any> = Function<T> | Object<T>

  export type Config<T extends Entry> =
    | T extends Apply<infer U> ? U
    : T extends Construct<infer U> ? U
    : T extends Object<infer U> ? U
    : never

  export interface Meta {
    name?: string
    sideEffect?: boolean
  }

  export interface Object<T = any> extends Meta {
    apply: Apply<T>
  }

  export interface State<T = any> extends Meta {
    id?: string
    parent?: State
    context?: Context
    config?: T
    plugin?: Plugin.Entry
    children: Plugin.Entry[]
    disposables: Disposable[]
  }

  export interface Library {}

  export type Teleporter<D extends readonly (keyof Library)[]> = (ctx: Context, ...modules: From<D>) => void

  type From<D extends readonly unknown[]> = D extends readonly [infer L, ...infer R]
    ? [L extends keyof Library ? Library[L] : unknown, ...From<R>]
    : []

  export class Registry extends Map<Plugin.Function, State> {
    resolve(plugin: Plugin.Entry) {
      return plugin && (typeof plugin === 'function' ? plugin : plugin.apply)
    }

    get(plugin: Plugin.Entry) {
      return super.get(this.resolve(plugin))
    }

    set(plugin: Plugin.Entry, state: State) {
      return super.set(this.resolve(plugin), state)
    }

    has(plugin: Plugin.Entry) {
      return super.has(this.resolve(plugin))
    }

    delete(plugin: Plugin.Entry) {
      return super.delete(this.resolve(plugin))
    }
  }
}

function isBailed(value: any) {
  return value !== null && value !== false && value !== undefined
}

function safeRequire(id: string) {
  try {
    return require(id)
  } catch {}
}

type Filter = (session: Session) => boolean
type PartialSeletor<T> = (...values: T[]) => Context

interface Selector<T> extends PartialSeletor<T> {
  except?: PartialSeletor<T>
}

export interface Context extends Context.Delegates {}

export class Context {
  static readonly middleware = Symbol('middleware')
  static readonly current = Symbol('source')

  protected _bots: Bot[] & Record<string, Bot>

  protected constructor(public filter: Filter, public app?: App, private _plugin: Plugin.Entry = null) {}

  private static inspect(plugin: Plugin.Entry) {
    return !plugin ? 'root' : typeof plugin === 'object' && plugin.name || 'anonymous'
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Context <${Context.inspect(this._plugin)}>`
  }

  private createSelector<K extends keyof Session>(key: K) {
    const selector: Selector<Session[K]> = (...args) => this.select(key, ...args)
    selector.except = (...args) => this.unselect(key, ...args)
    return selector
  }

  get user() {
    return this.createSelector('userId')
  }

  get self() {
    return this.createSelector('selfId')
  }

  get group() {
    return this.createSelector('groupId')
  }

  get channel() {
    return this.createSelector('channelId')
  }

  get platform() {
    return this.createSelector('platform')
  }

  get private() {
    return this.unselect('groupId').user
  }

  get bots() {
    return this.app._bots
  }

  logger(name: string) {
    return new Logger(name)
  }

  select<K extends keyof Session>(key: K, ...values: Session[K][]) {
    return this.intersect((session) => {
      return values.length ? values.includes(session[key]) : !!session[key]
    })
  }

  unselect<K extends keyof Session>(key: K, ...values: Session[K][]) {
    return this.intersect((session) => {
      return values.length ? !values.includes(session[key]) : !session[key]
    })
  }

  any() {
    return new Context(() => true, this.app, this._plugin)
  }

  never() {
    return new Context(() => false, this.app, this._plugin)
  }

  union(arg: Filter | Context) {
    const filter = typeof arg === 'function' ? arg : arg.filter
    return new Context(s => this.filter(s) || filter(s), this.app, this._plugin)
  }

  intersect(arg: Filter | Context) {
    const filter = typeof arg === 'function' ? arg : arg.filter
    return new Context(s => this.filter(s) && filter(s), this.app, this._plugin)
  }

  except(arg: Filter | Context) {
    const filter = typeof arg === 'function' ? arg : arg.filter
    return new Context(s => this.filter(s) && !filter(s), this.app, this._plugin)
  }

  match(session?: Session) {
    return !session || this.filter(session)
  }

  get state() {
    return this.app.registry.get(this._plugin)
  }

  addSideEffect(state = this.state) {
    while (state && !state.sideEffect) {
      state.sideEffect = true
      state = state.parent
    }
  }

  private teleport(modules: any[], callback: Plugin.Teleporter<any>) {
    const states: Plugin.State[] = []
    for (const module of modules) {
      const state = this.app.registry.get(module)
      if (!state) return
      states.push(state)
    }
    const plugin = (ctx: Context) => callback(ctx, ...modules as [])
    const dispose = () => this.dispose(plugin)
    this.plugin(plugin)
    states.every(state => state.disposables.push(dispose))
    this.before('disconnect', () => {
      states.every(state => remove(state.disposables, dispose))
    })
  }

  with<D extends readonly (keyof Plugin.Library)[]>(deps: D, callback: Plugin.Teleporter<D>) {
    const modules = deps.map(safeRequire)
    if (!modules.every(val => val)) return this
    this.teleport(modules, callback)
    this.on('plugin-added', (added) => {
      const modules = deps.map(safeRequire)
      if (modules.includes(added)) this.teleport(modules, callback)
    })
    return this
  }

  plugin<T extends Plugin.Entry>(plugin: T, options?: boolean | Plugin.Config<T>): this
  plugin(plugin: Plugin.Entry, options?: any) {
    if (options === false) return this
    if (options === true) options = undefined

    if (this.app.registry.has(plugin)) {
      this.logger('app').warn(new Error(`duplicate plugin <${Context.inspect(plugin)}> detected`))
      return this
    }

    const ctx: this = Object.create(this)
    defineProperty(ctx, '_plugin', plugin)
    this.app.registry.set(plugin, {
      plugin,
      id: Random.id(),
      context: this,
      config: options,
      parent: this.state,
      children: [],
      disposables: [],
    })
 
    if (typeof plugin === 'function') {
      if (Object.prototype.toString.call(plugin).startsWith('class ')) {
        Reflect.construct(plugin, [ctx, options])
      } else {
        Reflect.apply(plugin, null, [ctx, options])
      }
    } else if (plugin && typeof plugin === 'object' && typeof plugin.apply === 'function') {
      ctx.state.name = plugin.name
      if (plugin.sideEffect) ctx.addSideEffect()
      plugin.apply(ctx, options)
    } else {
      this.app.registry.delete(plugin)
      throw new Error('invalid plugin, expect function or object with an "apply" method')
    }

    this.state.children.push(plugin)
    this.emit('plugin-added', plugin, this.app.registry)
    return this
  }

  async dispose(plugin = this._plugin) {
    const state = this.app.registry.get(plugin)
    if (!state) return
    if (state.sideEffect) throw new Error('plugins with side effect cannot be disposed')
    await Promise.allSettled([
      ...state.children.slice().map(plugin => this.dispose(plugin)),
      ...state.disposables.map(dispose => dispose()),
    ]).finally(() => {
      this.app.registry.delete(plugin)
      remove(state.parent.children, plugin)
      this.emit('plugin-removed', plugin, this.app.registry)
    })
  }

  async parallel<K extends Event>(name: K, ...args: Parameters<EventMap[K]>): Promise<Await<ReturnType<EventMap[K]>>[]>
  async parallel<K extends Event>(session: Session, name: K, ...args: Parameters<EventMap[K]>): Promise<Await<ReturnType<EventMap[K]>>[]>
  async parallel(...args: any[]) {
    const tasks: Promise<any>[] = []
    const session = typeof args[0] === 'object' ? args.shift() : null
    const name = args.shift()
    for (const [context, callback] of this.app._hooks[name] || []) {
      if (!context.match(session)) continue
      tasks.push(callback.apply(session, args))
    }
    return Promise.all(tasks)
  }

  emit<K extends Event>(name: K, ...args: Parameters<EventMap[K]>): void
  emit<K extends Event>(session: Session, name: K, ...args: Parameters<EventMap[K]>): void
  emit(...args: [any, ...any[]]) {
    this.parallel(...args)
  }

  waterfall<K extends Event>(name: K, ...args: Parameters<EventMap[K]>): Promisify<ReturnType<EventMap[K]>>
  waterfall<K extends Event>(session: Session, name: K, ...args: Parameters<EventMap[K]>): Promisify<ReturnType<EventMap[K]>>
  async waterfall(...args: [any, ...any[]]) {
    const session = typeof args[0] === 'object' ? args.shift() : null
    const name = args.shift()
    for (const [context, callback] of this.app._hooks[name] || []) {
      if (!context.match(session)) continue
      const result = await callback.apply(session, args)
      args[0] = result
    }
    return args[0]
  }

  chain<K extends Event>(name: K, ...args: Parameters<EventMap[K]>): ReturnType<EventMap[K]>
  chain<K extends Event>(session: Session, name: K, ...args: Parameters<EventMap[K]>): ReturnType<EventMap[K]>
  chain(...args: [any, ...any[]]) {
    const session = typeof args[0] === 'object' ? args.shift() : null
    const name = args.shift()
    for (const [context, callback] of this.app._hooks[name] || []) {
      if (!context.match(session)) continue
      const result = callback.apply(session, args)
      args[0] = result
    }
    return args[0]
  }

  serial<K extends Event>(name: K, ...args: Parameters<EventMap[K]>): Promisify<ReturnType<EventMap[K]>>
  serial<K extends Event>(session: Session, name: K, ...args: Parameters<EventMap[K]>): Promisify<ReturnType<EventMap[K]>>
  async serial(...args: any[]) {
    const session = typeof args[0] === 'object' ? args.shift() : null
    const name = args.shift()
    for (const [context, callback] of this.app._hooks[name] || []) {
      if (!context.match(session)) continue
      const result = await callback.apply(session, args)
      if (isBailed(result)) return result
    }
  }

  bail<K extends Event>(name: K, ...args: Parameters<EventMap[K]>): ReturnType<EventMap[K]>
  bail<K extends Event>(session: Session, name: K, ...args: Parameters<EventMap[K]>): ReturnType<EventMap[K]>
  bail(...args: any[]) {
    const session = typeof args[0] === 'object' ? args.shift() : null
    const name = args.shift()
    for (const [context, callback] of this.app._hooks[name] || []) {
      if (!context.match(session)) continue
      const result = callback.apply(session, args)
      if (isBailed(result)) return result
    }
  }

  on<K extends Event>(name: K, listener: EventMap[K], prepend?: boolean): () => boolean
  on(name: string & Event, listener: Disposable, prepend = false) {
    const method = prepend ? 'unshift' : 'push'

    // handle special events
    if (name === 'connect' && this.app.status === App.Status.open) {
      return listener(), () => false
    } else if (name === 'before-disconnect') {
      this.state.disposables[method](listener)
      return () => remove(this.state.disposables, listener)
    } else if (name === 'before-connect') {
      // before-connect is side effect
      this.addSideEffect()
    } else if (typeof name === 'string' && name.startsWith('delegate/')) {
      if (this[name.slice(9)]) return listener(), () => false
    }

    const hooks = this.app._hooks[name] ||= []
    if (hooks.length >= this.app.options.maxListeners) {
      this.logger('app').warn(
        'max listener count (%d) for event "%s" exceeded, which may be caused by a memory leak',
        this.app.options.maxListeners, name,
      )
    }

    hooks[method]([this, listener])
    const dispose = () => this.off(name, listener)
    this.state.disposables.push(dispose)
    return dispose
  }

  before<K extends BeforeEvent>(name: K, listener: BeforeEventMap[K], append = false) {
    const seg = name.split('/')
    seg[seg.length - 1] = 'before-' + seg[seg.length - 1]
    return this.on(seg.join('/') as Event, listener, !append)
  }

  once<K extends Event>(name: K, listener: EventMap[K], prepend = false) {
    const dispose = this.on(name, function (...args: any[]) {
      dispose()
      return listener.apply(this, args)
    } as any, prepend)
    return dispose
  }

  off<K extends Event>(name: K, listener: EventMap[K]) {
    const index = (this.app._hooks[name] || [])
      .findIndex(([context, callback]) => context === this && callback === listener)
    if (index >= 0) {
      this.app._hooks[name].splice(index, 1)
      return true
    }
  }

  middleware(middleware: Middleware, prepend = false) {
    return this.on(Context.middleware, middleware, prepend)
  }

  private createTimerDispose(timer: NodeJS.Timeout) {
    const dispose = () => {
      clearTimeout(timer)
      return remove(this.state.disposables, dispose)
    }
    this.state.disposables.push(dispose)
    return dispose
  }

  setTimeout(callback: (...args: any[]) => void, ms: number, ...args: any[]) {
    const dispose = this.createTimerDispose(setTimeout(() => {
      dispose()
      callback()
    }, ms, ...args))
    return dispose
  }

  setInterval(callback: (...args: any[]) => void, ms: number, ...args: any[]) {
    return this.createTimerDispose(setInterval(callback, ms, ...args))
  }

  command<D extends string>(def: D, config?: Command.Config): Command<never, never, Argv.ArgumentType<D>>
  command<D extends string>(def: D, desc: string, config?: Command.Config): Command<never, never, Argv.ArgumentType<D>>
  command(def: string, ...args: [Command.Config?] | [string, Command.Config?]) {
    const desc = typeof args[0] === 'string' ? args.shift() as string : ''
    const config = args[0] as Command.Config
    const path = def.split(' ', 1)[0].toLowerCase()
    const decl = def.slice(path.length)
    const segments = path.split(/(?=[./])/g)

    let parent: Command, root: Command
    segments.forEach((segment, index) => {
      const code = segment.charCodeAt(0)
      const name = code === 46 ? parent.name + segment : code === 47 ? segment.slice(1) : segment
      let command = this.app._commands.get(name)
      if (command) {
        if (parent) {
          if (command === parent) {
            throw new Error(`cannot set a command (${command.name}) as its own subcommand`)
          }
          if (command.parent) {
            if (command.parent !== parent) {
              throw new Error(`cannot create subcommand ${path}: ${command.parent.name}/${command.name} already exists`)
            }
          } else {
            command.parent = parent
            parent.children.push(command)
          }
        }
        return parent = command
      }
      command = new Command(name, decl, index === segments.length - 1 ? desc : '', this)
      if (!root) root = command
      if (parent) {
        command.parent = parent
        command.config.authority = parent.config.authority
        parent.children.push(command)
      }
      parent = command
    })

    if (desc) parent.description = desc
    Object.assign(parent.config, config)
    if (!config?.patch) {
      if (root) this.state.disposables.unshift(() => root.dispose())
      return parent
    }

    if (root) root.dispose()
    const command = Object.create(parent)
    command._disposables = this.state.disposables
    return command
  }

  async transformAssets(content: string, assets = this.assets) {
    if (!assets) return content
    return segment.transformAsync(content, Object.fromEntries(assets.types.map((type) => {
      return [type, async (data) => segment(type, { url: await assets.upload(data.url, data.file) })]
    })))
  }

  getBot(platform: Platform, selfId?: string) {
    if (selfId) return this.bots[`${platform}:${selfId}`]
    return this.bots.find(bot => bot.platform === platform)
  }

  getSelfIds(type?: Platform, assignees?: readonly string[]): Record<string, readonly string[]> {
    if (type) {
      assignees ||= this.app.bots.filter(bot => bot.platform === type).map(bot => bot.selfId)
      return { [type]: assignees }
    }
    const platforms: Record<string, string[]> = {}
    for (const bot of this.app.bots) {
      (platforms[bot.platform] ||= []).push(bot.selfId)
    }
    return platforms
  }

  async broadcast(content: string, forced?: boolean): Promise<string[]>
  async broadcast(channels: readonly string[], content: string, forced?: boolean): Promise<string[]>
  async broadcast(...args: [string, boolean?] | [readonly string[], string, boolean?]) {
    let channels: string[]
    if (Array.isArray(args[0])) channels = args.shift() as any
    const [content, forced] = args as [string, boolean]
    if (!content) return []

    const data = this.database
      ? await this.database.getAssignedChannels(['id', 'assignee', 'flag'])
      : channels.map((id) => {
        const [type] = id.split(':')
        const bot = this.getBot(type as never)
        return bot && { id, assignee: bot.selfId, flag: 0 }
      }).filter(Boolean)

    const assignMap: Record<string, Record<string, string[]>> = {}
    for (const { id, assignee, flag } of data) {
      if (channels && !channels.includes(id)) continue
      if (!forced && (flag & Channel.Flag.silent)) continue
      const [type] = id.split(':')
      const cid = id.slice(type.length + 1)
      const map = assignMap[type] ||= {}
      if (map[assignee]) {
        map[assignee].push(cid)
      } else {
        map[assignee] = [cid]
      }
    }

    return (await Promise.all(Object.entries(assignMap).flatMap(([type, map]) => {
      return this.app.bots.map((bot) => {
        if (bot.platform !== type) return Promise.resolve([])
        return bot.broadcast(map[bot.selfId] || [], content)
      })
    }))).flat(1)
  }

  static delegate(key: string & keyof Context) {
    if (Object.prototype.hasOwnProperty.call(Context.prototype, key)) return
    const privateKey = Symbol(key)
    Object.defineProperty(Context.prototype, key, {
      get() {
        if (!this.app[privateKey]) return
        const value = Object.create(this.app[privateKey])
        defineProperty(value, Context.current, this)
        return value
      },
      set(value) {
        if (!this.app[privateKey]) this.emit('delegate/' + key)
        defineProperty(this.app, privateKey, value)
      },
    })
  }
}

Context.delegate('database')
Context.delegate('assets')
Context.delegate('cache')

export namespace Context {
  export interface Delegates {
    database: Database
    assets: Assets
    cache: Cache
  }
}

type FlattenEvents<T> = {
  [K in keyof T & string]: K | `${K}/${FlattenEvents<T[K]>}`
}[keyof T & string]

type SessionEventMap = {
  [K in FlattenEvents<Session.Events>]: K extends `${infer X}/${infer R}`
    ? R extends `${infer Y}/${any}`
      ? (session: Session.Payload<X, Y>) => void
      : (session: Session.Payload<X, R>) => void
    : (session: Session.Payload<K>) => void
}

type DelegateEventMap = {
  [K in keyof Context.Delegates as `delegate/${K}`]: () => void
}

type Event = keyof EventMap
type OmitSubstring<S extends string, T extends string> = S extends `${infer L}${T}${infer R}` ? `${L}${R}` : never
type BeforeEvent = OmitSubstring<Event & string, 'before-'>

export type BeforeEventMap = { [E in Event & string as OmitSubstring<E, 'before-'>]: EventMap[E] }

export interface EventMap extends SessionEventMap, DelegateEventMap {
  [Context.middleware]: Middleware

  // Koishi events
  'appellation'(name: string, session: Session): string
  'before-parse'(content: string, session: Session): Argv
  'parse'(argv: Argv, session: Session): string
  'before-attach-channel'(session: Session, fields: Set<Channel.Field>): void
  'attach-channel'(session: Session): Awaitable<void | boolean>
  'before-attach-user'(session: Session, fields: Set<User.Field>): void
  'attach-user'(session: Session): Awaitable<void | boolean>
  'before-attach'(session: Session): void
  'attach'(session: Session): void
  'before-send'(session: Session<never, never, Platform, 'send'>): Awaitable<void | boolean>
  'before-command'(argv: Argv): Awaitable<void | string>
  'command'(argv: Argv): Awaitable<void>
  'command-added'(command: Command): void
  'command-removed'(command: Command): void
  'middleware'(session: Session): void
  'plugin-added'(plugin: Plugin.Entry, registry: Map<Plugin.Entry, Plugin.State>): void
  'plugin-removed'(plugin: Plugin.Entry, registry: Map<Plugin.Entry, Plugin.State>): void
  'before-connect'(): Awaitable<void>
  'connect'(): void
  'before-disconnect'(): Awaitable<void>
  'disconnect'(): void
}
