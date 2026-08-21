# vendor/

## deepseek-harness

官方仓库 `deepseek-ai/deepseek-harness`，以 submodule 形式钉在某个发布 tag 上
（当前 `dsh-v0.1.1-rc.1`）。

**它只在开发与打包时用，不进 App。** 用户拿到的 dmg 里是构建好的运行时，
装 Krill 的人不需要 node、不需要 pnpm、不需要自己装 dsh。

### 为什么要放这一份

Krill 的附加功能（vision 等）曾经靠**给 npm 发布产物打补丁**实现 —— 直接改
`lib/index.js`。代价是上游每发一版补丁就贴不上：rc.7 → rc.8 时 3/4 的补丁失效，
功能被自动停用，每次都要人工重做一遍。

现在改成**在外面包一层**：用 dsh 自己公开的扩展点（`ctx.llm.registerAdapter()`
等）注册我们的实现，一行上游代码都不改。这一份 submodule 的作用是：

- 给我们的 wrapper 提供类型与编译期校验，确保没有绕开上游契约
- 明确记录「我们是对着哪个版本写的」
- 上游升级时，改这里的 tag 即可，改动可审、可回滚

### 升级上游

```bash
cd vendor/deepseek-harness
git fetch --tags
git checkout dsh-v<新版本>
cd ../..
git add vendor/deepseek-harness && git commit
```

然后重新打包 —— 用户那边只需要更新 Krill 本身。
