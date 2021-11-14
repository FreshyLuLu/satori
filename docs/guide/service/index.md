---
sidebarDepth: 2
---

# 使用服务

在之前的章节中，你或许已经意识到了 Koishi 的大部分特性都是围绕上下文进行设计的——即使不同的上下文可以隶属于不同的插件、配置了不同的过滤器，但许多功能在不同的上下文中访问的效果是一致的。换言之，应用其实可以被理解成一个容器，搭载了各种各样的功能 (如数据库和适配器等)，而上下文则单纯提供了一个接口来访问它们。这种组织形式被称为**服务 (Service)**。

对于已经有 IoC / DI 概念的同学来说，服务就是一种类似于 IoC 的实现（但并非通过 DI 实现，具体实现方式会在下面介绍）。Service API 通过 TypeScript 特有的依赖合并 (Declaration Merging) 机制提供了容器内服务的快速访问。

## 内置的服务

Koishi 规范化了一系列内置服务。它们可以分为两种类型：

第一种是由 koishi 直接自带的服务。

- ctx.bots
- ctx.http
- ctx.router

第二种是由 Koishi 所定义但并未实现的服务。你可以选择适当的插件来实现它们。在你安装相应的插件之前，相关的功能是无法正常运行的。

- ctx.assets
- ctx.cache
- ctx.database

相关的插件名通常以服务名作为前缀，例如 assets-local, cache-redis, database-mysql 等等。这并非强制的要求，但我们建议插件开发者也都遵循这个规范，这有助于让使用者对你插件的功能建立一个更明确的认识。

值得注意的是，Koishi 内置官方插件 @koishijs/plugin-cache-lru。你依然可以通过安装其他缓存插件覆盖默认的实现，但即使你不这样做你也可以正常使用 Cache API。

## 自定义服务

如果你也想开发出像 @koishijs/plugin-webui 这样的插件，那么你或许也会需要定义一个通用的上下文属性。这非常简单：

```js
// 还是以上面的 webui 为例
Context.service('webui')

// 假如你在某个上下文设置了这个值，其他的上下文也将拥有此属性
app.group().console = new WebUI()
app.private().console instanceof WebUI // true
```

这个静态方法不仅可以在全体上下文中共享某一个对象，还可以定义具有热重载性质的接口。还记得上面的 `webui.addEntry()` 方法吗？如果我希望当 teach 插件被卸载时，上面注册的 entry 也同时被移除，可以做到吗？这就要用到特殊的 `Context.current` 属性了，它只在被 `Context.service()` 声明的类中可用：

```js
class WebUI {
  addEntry(filename) {
    // Context.current 是一个特殊的 symbol，用来标记调用这个方法时所在的上下文
    const ctx = this[Context.current]
    this.entries.add(filename)

    // 当 teach 插件被卸载时，自然会触发 ctx 的 disconnect 事件，这样就实现了无副作用的方法
    ctx.before('disconnect', () => {
      this.entries.delete(filename)
    })
  }
}
```