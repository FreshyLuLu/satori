import * as utils from '@koishijs/utils'
import { Platform } from './adapter'
import { App } from './app'
import { Command } from './command'
import { Context, MethodDecorator, Plugin } from './context'

export type TableType = keyof Tables

export interface Tables {
  user: User
  channel: Channel
}

export namespace Tables {
  type Unique<K> = (K | K[])[]

  export interface Field<T = any> {
    type: Field.Type<T>
    length?: number
    nullable?: boolean
    initial?: T
  }

  export namespace Field {
    export const numberTypes: Type[] = ['integer', 'unsigned', 'float', 'double']
    export const stringTypes: Type[] = ['char', 'string', 'text']
    export const dateTypes: Type[] = ['timestamp', 'date', 'time']
    export const objectTypes: Type[] = ['list', 'json']

    type WithParam<S extends string> = S | `${S}(${any})`

    export type Config<O> = {
      [K in keyof O]?: Field<O[K]> | WithParam<Type<O[K]>>
    }

    export type Type<T = any> =
      | T extends number ? 'integer' | 'unsigned' | 'float' | 'double'
      : T extends string ? 'char' | 'string' | 'text'
      : T extends Date ? 'timestamp' | 'date' | 'time'
      : T extends any[] ? 'list' | 'json'
      : T extends object ? 'json'
      : never

    const regexp = /^\w+(\(.+\))?$/

    export function parse(definition: string) {
      const capture = regexp.exec(definition)
      if (!capture) throw new Error('invalid field definition')
      return { type: capture[0], length: +capture[1] } as Field
    }
  }

  export interface Meta<O = any> {
    type?: 'random' | 'incremental'
    primary?: string & keyof O
    unique?: Unique<string & keyof O>
    foreign?: {
      [K in keyof O]?: [TableType, string]
    }
    fields?: {
      [K in keyof O]?: Field<O[K]>
    }
  }

  export const config: { [T in TableType]?: Meta<Tables[T]> } = {}

  export function extend<T extends TableType>(name: T, fields?: Field.Config<Tables[T]>, meta?: Meta<Tables[T]>): void
  export function extend(name: string, fields = {}, meta: Meta = {}) {
    const oldConfig = config[name] || {}
    config[name] = {
      type: 'incremental',
      primary: 'id',
      ...meta,
      unique: [...oldConfig.unique || [], ...meta.unique || []],
      foreign: { ...oldConfig.foreign, ...meta.foreign },
      fields: { ...oldConfig.fields, ...fields },
    }
  }

  export function create<T extends TableType>(name: T): Tables[T] {
    const { fields } = Tables.config[name]
    const result = {} as Tables[T]
    for (const key in fields) {
      if (fields[key].initial !== undefined) {
        result[key] = utils.clone(fields[key].initial)
      }
    }
    return result
  }

  extend('user', {
    id: { type: 'string', length: 50 },
    name: { type: 'string', length: 50 },
    flag: { type: 'unsigned', length: 20, initial: 0 },
    authority: { type: 'unsigned', length: 4, initial: 0 },
    usage: { type: 'json', initial: {} },
    timers: { type: 'json', initial: {} },
  })

  extend('channel', {
    id: { type: 'string', length: 50 },
    flag: { type: 'unsigned', length: 20, initial: 0 },
    assignee: { type: 'string', length: 50 },
    disable: { type: 'list', initial: [] },
  })
}

export type Query<T extends TableType> = Query.Expr<Tables[T]> | Query.Shorthand

export namespace Query {
  export type IndexType = string | number
  export type IndexKeys<O, T = any> = string & { [K in keyof O]: O[K] extends T ? K : never }[keyof O]
  export type Field<T extends TableType> = string & keyof Tables[T]
  export type Index<T extends TableType> = IndexKeys<Tables[T], IndexType>

  export interface FieldExpr<T> {
    $regex?: RegExp
    $regexFor?: string
    $in?: T[]
    $nin?: T[]
    $eq?: T
    $ne?: T
    $gt?: T
    $gte?: T
    $lt?: T
    $lte?: T
  }

  export interface LogicalExpr<T> {
    $or?: Expr<T>[]
    $and?: Expr<T>[]
    $not?: Expr<T>
  }

  export type Shorthand<T = IndexType> = T | T[] | RegExp
  export type FieldQuery<T> = FieldExpr<T> | Shorthand<T>
  export type Expr<T = any> = LogicalExpr<T> & {
    [K in keyof T]?: FieldQuery<T[K]>
  }

  export function resolve<T extends TableType>(name: T, query: Query<T>): Expr<Tables[T]> {
    if (Array.isArray(query) || query instanceof RegExp || ['string', 'number'].includes(typeof query)) {
      const { primary } = Tables.config[name]
      return { [primary]: query } as any
    }
    return query as any
  }

  export interface Options<T extends string> {
    limit?: number
    offset?: number
    fields?: T[]
  }

  export type Modifier<T extends string = any> = T[] | Options<T>

  export function resolveModifier<T extends string>(modifier: Modifier<T>): Options<T> {
    if (Array.isArray(modifier)) return { fields: modifier }
    return modifier || {}
  }

  export interface Methods {
    get<T extends TableType, K extends Field<T>>(table: T, query: Query<T>, modifier?: Modifier<K>): Promise<Pick<Tables[T], K>[]>
    remove<T extends TableType>(table: T, query: Query<T>): Promise<void>
    create<T extends TableType>(table: T, data: Partial<Tables[T]>): Promise<Tables[T]>
    update<T extends TableType>(table: T, data: Partial<Tables[T]>[], key?: Index<T> | Index<T>[]): Promise<void>
  }
}

type BaseSeletorDecorator<R extends any[]> = (...values: R) => MethodDecorator

interface SelectorDecorator<R extends any[]> extends BaseSeletorDecorator<R> {
  Except?: BaseSeletorDecorator<R>
}

type ExtractParameters<U, T extends keyof U> = U[T] extends (...args: infer R) => any ? R : never

function createPartialSelector<T extends keyof Context>(name: T, except?: boolean): BaseSeletorDecorator<ExtractParameters<Context, T>> {
  return (...args) => (target, prop, desc) => {
    const map = Plugin.meta.get(target)
    const callback = map?.get(desc.value)
    if (!callback) return
    map.set(desc.value, function () {
      let selector: any = this[name]
      if (except) selector = selector.except
      callback.call(selector(...args))
    })
  }
}

function createSelector<T extends keyof Context, U>(name: T, source?: U): U & SelectorDecorator<ExtractParameters<Context, T>> {
  const value: any = createPartialSelector(name)
  value.Except = createPartialSelector(name, true)
  return Object.assign(value, source)
}

export const Any = createPartialSelector('any')
export const Never = createPartialSelector('never')
export const Self = createSelector('self')
export const Group = createSelector('group')
export const Private = createSelector('private')

type MaybeArray<T> = T | T[]

export interface User extends Record<Platform, string> {
  id: string
  flag: number
  authority: number
  name: string
  usage: Record<string, number>
  timers: Record<string, number>
}

namespace UserStatic {
  export enum Flag {
    ignore = 1,
  }

  export const Field = Command.decorate('userFields')
  export const fields: User.Field[] = []
  type Getter = <T extends User.Index>(type: T, id: string) => Partial<User>
  const getters: Getter[] = []

  /**
   * @deprecated use `Tables.extend('user', { fields })` instead
   */
  export function extend(getter: Getter) {
    getters.push(getter)
    fields.push(...Object.keys(getter(null as never, '0')) as any)
  }

  export function create<T extends User.Index>(type: T, id: string) {
    const result = Tables.create('user')
    result[type] = id
    for (const getter of getters) {
      Object.assign(result, getter(type, id))
    }
    return result as User
  }
}

export namespace User {
  export type Flag = UserStatic.Flag
  export type Field = keyof User
  export type Index = Platform | 'name' | 'id'
  export type Observed<K extends Field = Field> = utils.Observed<Pick<User, K>, Promise<void>>
}

export const User = createSelector('user', UserStatic)

export interface Channel {
  id: string
  type: string
  flag: number
  assignee: string
  disable: string[]
}

namespace ChannelStatic {
  export enum Flag {
    ignore = 1,
    silent = 4,
  }

  export const Field = Command.decorate('channelFields')
  export const fields: Channel.Field[] = []
  type Getter = (type: Platform, id: string) => Partial<Channel>
  const getters: Getter[] = []

  /**
   * @deprecated use `Tables.extend('user', { fields })` instead
   */
  export function extend(getter: Getter) {
    getters.push(getter)
    fields.push(...Object.keys(getter(null as never, '')) as any)
  }

  export function create(type: Platform, id: string) {
    const result = Tables.create('channel')
    result.id = `${type}:${id}`
    for (const getter of getters) {
      Object.assign(result, getter(type, id))
    }
    return result
  }
}

export namespace Channel {
  export type Flag = ChannelStatic.Flag
  export type Field = keyof Channel
  export type Observed<K extends Field = Field> = utils.Observed<Pick<Channel, K>, Promise<void>>

  export interface Methods {
    getAssignedChannels<K extends Field>(fields?: K[], assignMap?: Record<string, readonly string[]>): Promise<Pick<Channel, K>[]>
  }
}

export const Channel = createSelector('channel', ChannelStatic)

export interface Database extends Query.Methods, Channel.Methods {}

export abstract class Database {
  abstract start(): void | Promise<void>
  abstract stop(): void | Promise<void>

  constructor(public app: App) {
    app.before('connect', () => this.start())
    app.before('disconnect', () => this.stop())
  }

  getUser<K extends User.Field, T extends string>(type: T, id: string, modifier?: Query.Modifier<K>): Promise<Pick<User, K> & Record<T, string>>
  getUser<K extends User.Field>(type: string, ids: string[], modifier?: Query.Modifier<K>): Promise<Pick<User, K>[]>
  async getUser(type: User.Index, id: MaybeArray<string>, modifier?: Query.Modifier) {
    const data = await this.get('user', { [type]: id }, modifier)
    return Array.isArray(id) ? data : data[0] && { ...data[0], [type]: id }
  }

  setUser(type: string, id: string, data: Partial<User>) {
    return this.update('user', [{ ...data, [type]: id }], type as never)
  }

  getChannel<K extends Channel.Field>(type: string, id: string, modifier?: Query.Modifier<K>): Promise<Pick<Channel, K | 'id' | 'type'>>
  getChannel<K extends Channel.Field>(type: string, ids: string[], modifier?: Query.Modifier<K>): Promise<Pick<Channel, K>[]>
  async getChannel(type: string, id: MaybeArray<string>, modifier?: Query.Modifier<Channel.Field>) {
    const data = await this.get('channel', { type, id }, modifier)
    return Array.isArray(id) ? data : data[0] && { ...data[0], type, id }
  }

  setChannel(type: string, id: string, data: Partial<Channel>) {
    // TODO: use primary key (type, id) by default
    return this.update('channel', [{ ...data, type, id }], ['type', 'id'])
  }
}

export namespace Database {
  export interface Library {}

  type Methods<S, T> = {
    [K in keyof S]?: S[K] extends (...args: infer R) => infer U ? (this: T, ...args: R) => U : S[K]
  }

  type Constructor<T> = new (...args: any[]) => T
  type ExtensionMethods<T> = Methods<Database, T extends Constructor<infer I> ? I : never>
  type Extension<T> = ((Database: T) => void) | ExtensionMethods<T>

  export function extend<K extends keyof Library>(module: K, extension: Extension<Library[K]>): void
  export function extend<T extends Constructor<unknown>>(module: T, extension: Extension<T>): void
  export function extend(module: any, extension: any) {
    let Database: any
    try {
      Database = typeof module === 'string' ? require(module).default : module
    } catch {
      return
    }

    if (typeof extension === 'function') {
      extension(Database)
    } else {
      Object.assign(Database.prototype, extension)
    }
  }
}

export interface Assets {
  types: readonly Assets.Type[]
  upload(url: string, file: string): Promise<string>
  stats(): Promise<Assets.Stats>
}

export namespace Assets {
  export type Type = 'image' | 'audio' | 'video' | 'file'

  export interface Stats {
    assetCount?: number
    assetSize?: number
  }
}

export interface Cache {
  get<T extends keyof Cache.Tables>(table: T, key: string): Cache.Tables[T] | Promise<Cache.Tables[T]>
  set<T extends keyof Cache.Tables>(table: T, key: string, value: Cache.Tables[T]): void | Promise<void>
}

export namespace Cache {
  export interface Tables {
    channel: utils.Observed<Partial<Channel>>
    user: utils.Observed<Partial<User>>
  }
}
