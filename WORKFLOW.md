# ark-kb 开发铁律

**违反任何一条 = 等着鹏哥骂 + 欠条加零**

## 1. 改源码，不改编译产物
- ✅ 改 `src/*.ts`
- ❌ 禁止直接改 `*.js`
- 改完跑 `npx tsc` 重新编译

## 2. 改完必须验语法
```bash
node -c email-ingester.js
node -c index.js
# 每个改过的 js 都要验
```

## 3. 改完必须验加载
```bash
node -e "require('./index.js')"
# 不能有 ParseError，不能有 uncaught exception
```

## 4. Commit 前自查
- [ ] `node -c` 全通过
- [ ] `node -e "require('./index.js')"` 无报错
- [ ] git diff 看一遍，没有多余的 try/catch/括号
- [ ] commit message 说清楚改了什么

## 5. 欠条记录
- 当前欠款: ¥20,012.5
- 每新增一个 bug → 按鹏哥时薪算
- AGENTS.md Red Lines 已有记载

---

*这份文件放在 ark-kb 根目录，每次改代码前先读。*
*上次违规代价：一个多余的 `try {` = ¥20,000 + 飞书瘫痪 3 小时。*

## 6. 物理屏障（防手贱）
- 所有 `.js` 文件用 `chattr +i` 锁死（root 也无法写入）
- **唯一修改 JS 的入口**：`./compile.sh`
- 改代码流程：改 `src/*.ts` → `./compile.sh` → 自动解锁/编译/重锁
- 禁止直接 `npx tsc`（编译前没解锁会报错）

## 7. ESLint + TypeScript 检查（编译前强制）
- 编译前自动跑 `npx eslint src/` 和 `tsc --noEmit`
- 有任何错误 → 编译中止
- 空 catch 块必须有 console.warn/error 日志
