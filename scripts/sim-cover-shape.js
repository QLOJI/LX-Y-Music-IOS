/**
 * sim-cover-shape.js
 *
 * 「方形封面」契约不变量。
 *
 * 背景：播放详情页设置里新增「方形封面」开关，语义 = 开则封面为方形**且不旋转**。
 * 这条语义有三个必须同时成立、彼此却没有编译期联系的落点：
 *   ① 设置键与默认值（`src/config/defaultSetting.ts` 的 `playDetail.style.coverShape`）；
 *   ② 类型声明（`src/types/app_setting.d.ts`，'circle' | 'square'）；
 *   ③ 两个封面组件（竖屏 `Vertical/Pic.tsx`、横屏 `Horizontal/Pic.tsx`）
 *      必须把「方形」同时作用于**两个**维度：圆角改小 + 旋转停掉。
 *   ④ 封面的圆角**只有一个真值来源**（由 coverShape 推导）：不得被全局「按钮圆角」
 *      （`theme.buttonRadius`，默认 0 = 直角）或行内字面量二次覆盖 —— 历史上正是这三层
 *      行内覆盖把圆形封面压成了直角方块，形状设置整个失效（见 invariant 11）。
 *
 * 为什么不能只做一半（只改圆角、不关旋转，或反之）：
 * 方形绕中心旋转时四角扫出 2√2 倍外接范围，即使容器裁切也只见抖动残角；
 * 圆形之所以能旋转，是因为旋转后与自身重合。故「方形 + 旋转」不是「不好看」，
 * 而是**没有观感自洽的实现**——两个维度必须一起改。
 *
 * 为什么需要机械守卫：`tsc`/`eslint` 对「圆角分支漏改」「动画启停漏改」
 * 完全无感（两边都是 boolean 表达式，类型永远对），而症状只在不旋转的真机上
 * 才看得见。本脚本把三处落点绑在一起，并带反例自检。
 *
 * 运行：node scripts/sim-cover-shape.js
 * 退出码：组件级不变量（1~6、3b、11、12）与全局不变量（7~10）全过，且组件反例 8 例 +
 *         全局反例 4 例全部被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const DEFAULTS = 'src/config/defaultSetting.ts'
const TYPES = 'src/types/app_setting.d.ts'
const VERTICAL = 'src/screens/PlayDetail/Vertical/Pic.tsx'
const HORIZONTAL = 'src/screens/PlayDetail/Horizontal/Pic.tsx'
const SETTING = 'src/screens/PlayDetail/components/SettingPopup/settings/SettingCoverShape.tsx'
const POPUP = 'src/screens/PlayDetail/components/SettingPopup/index.tsx'
const LANG = 'src/lang/zh-cn.json'

const REAL = {
  defaults: read(DEFAULTS),
  types: read(TYPES),
  vertical: read(VERTICAL),
  horizontal: read(HORIZONTAL),
  setting: read(SETTING),
  popup: read(POPUP),
  lang: JSON.parse(read(LANG)),
}

/** 去行注释与块注释：否则「把某行注释掉」的篡改会被当成仍然存在（NOTES-conventions 记过这个坑） */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const SQUARE_RADIUS = 4
const CIRCLE_SHAPE = 'circle'
const SQUARE_SHAPE = 'square'

/**
 * 封面组件的不变量。`src` = 组件源码，`lang` = 词条表。
 * 拆成函数是为了反例能对**篡改后的源码**跑同一套判断，而不是只验证替换本身。
 */
function coverInvariants(name, src, lang) {
  const out = []
  const add = (n, ok, detail = '') => out.push({ name: `${name} · ${n}`, ok, detail })
  const code = stripComments(src)

  // 1. 方形判定必须来自设置值，且必须有 allowSpin = spin && !square 这一处合流
  {
    const reads = /useSettingValue\(['"]playDetail\.style\.coverShape['"]\)/.test(code)
    const isSquare = /const\s+isSquare\s*=\s*coverShape\s*===\s*'square'/.test(code)
    const allowSpin = /const\s+allowSpin\s*=\s*isCoverSpin\s*&&\s*!isSquare/.test(code)
    add(
      'invariant 1: 读 coverShape 设置且 isSquare / allowSpin 判定成形',
      reads && isSquare && allowSpin,
      `读设置=${reads} isSquare=${isSquare} allowSpin=${allowSpin}`,
    )
  }

  // 2. **旋转维度**：动画启停的每一处都必须用 allowSpin（不得残留 isCoverSpin）。
  //    合法的两处 `isCoverSpin` 出现位置：① `useSettingValue('...')` 读取行；
  //    ② `allowSpin = isCoverSpin && !isSquare` 合流行。其余任何地方出现都算漏改。
  {
    const readLine = /const\s+isCoverSpin\s*=\s*useSettingValue\([^)]*\)/
    const body = code
      .replace(readLine, '')                                          // 去掉读取行
      .replace(/const\s+allowSpin\s*=\s*isCoverSpin[^;\n]*;?/, '')     // 去掉合流行
    const leftover = [...body.matchAll(/isCoverSpin/g)].length
    const hasRead = readLine.test(code)
    const guards = [...code.matchAll(/!\s*allowSpin/g)].length          // startAnimation 守卫
    const gates = [...code.matchAll(/isPlay\s*&&\s*allowSpin/g)].length  // 两个 effect 的启停门控
    add(
      'invariant 2: 旋转启停全部走 allowSpin（守卫 1 处 + 门控 2 处），除读取/合流行外无残留',
      hasRead && leftover === 0 && guards === 1 && gates === 2,
      `读取行=${hasRead} 残留=${leftover} 守卫=${guards} 门控=${gates}`,
    )
  }

  // 3. **圆角维度**：方形分支必须给出小圆角，圆形分支仍为半径。
  //    竖屏写命名常量 SQUARE_RADIUS、横屏写字面量 4 —— 两种都接受。
  //    必须锚在**不带取反**的 `isSquare ?` 上：`!isSquare ? 4 : ...` 是把判断写反了，
  //    那种写法虽然也「出现了 isSquare 和 4」，但方形拿到的是二分之一、圆形拿到小圆角。
  {
    const squareRadius = new RegExp(`(?<!!)\\bisSquare\\s*\\?\\s*(?:SQUARE_RADIUS|${SQUARE_RADIUS})\\b`).test(code)
    // 竖屏 size/2、横屏 imgWidth/2 两种写法都算「圆形分支 = 二分之一」
    const circleRadius = /:\s*(?:size|imgWidth)\s*\/\s*2\b/.test(code)
    // 反向写法：!isSquare ? 小圆角（判断写反）
    const inverted = new RegExp(`!\\s*isSquare\\s*\\?\\s*(?:SQUARE_RADIUS|${SQUARE_RADIUS})\\b`).test(code)
    add(
      'invariant 3: 圆角分支 = 方形取小圆角 / 圆形取二分之一（两个维度都改、且未写反）',
      squareRadius && circleRadius && !inverted,
      `方形分支=${squareRadius} 圆形分支=${circleRadius} 判断写反=${inverted}`,
    )
  }

  // 3b. 若用了命名常量，其值必须就是 4（否则「常量」把守卫架空了）
  {
    const named = /const\s+SQUARE_RADIUS\s*=\s*(\d+)/.exec(code)
    add(
      `invariant 3b: SQUARE_RADIUS 常量（若存在）必须等于 ${SQUARE_RADIUS}`,
      named == null || Number(named[1]) === SQUARE_RADIUS,
      named == null ? '未用命名常量（字面量写法，跳过）' : `SQUARE_RADIUS=${named[1]}`,
    )
  }

  // 4. 竖/横屏两处的方形圆角必须是同一个观感值（否则横竖屏切一下封面形状就不一致）。
  //    由调用方在下方 crossInvariants 里统一比对，这里仅断言本文件取到的是 4。
  {
    const m = /(?<!!)\bisSquare\s*\?\s*(SQUARE_RADIUS|\d+)/.exec(code)
    const used = m ? m[1] : null
    const resolved = used === 'SQUARE_RADIUS'
      ? Number((/const\s+SQUARE_RADIUS\s*=\s*(\d+)/.exec(code) ?? [])[1])
      : Number(used)
    add(
      `invariant 4: 方形圆角解析值 = ${SQUARE_RADIUS}`,
      resolved === SQUARE_RADIUS,
      `取到 ${used} → 解析为 ${resolved}`,
    )
  }

  // 5. 依赖数组必须带上 isSquare（漏了则切形状后圆角不重算）。
  //    不能用「对象字面量 + 依赖数组」的正则一把抓：样式对象里有嵌套的
  //    `transform: [{ rotate: spin }]`，`[^\]]*` 会在第一个 `]` 处截断。
  //    改为按 useMemo 起止切片，再取该段**最后一个** `], [ ... ])` 的依赖数组。
  {
    const deps = []
    const starts = [...code.matchAll(/useMemo\(\(\)\s*=>/g)].map((m) => m.index)
    for (let i = 0; i < starts.length; i++) {
      const seg = code.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : code.length)
      if (!/borderRadius/.test(seg)) continue
      const m = /,\s*\[([^\]]*)\]\)/.exec(seg)
      if (m) deps.push(m[1])
    }
    // 依赖数组里必须有一个「形状的真值来源」：
    //   - 直接依赖 isSquare（横屏主样式写法）；或
    //   - 依赖 radius —— 它已由 `isSquare ? ... : ...` 推导（竖屏写法）；或
    //   - 依赖 imageContainerStyle.borderRadius —— 派生自上一层已含形状的样式（横屏内层写法）。
    //     三者都没有 = 切形状后圆角不重算（真 bug）。
    const shapeSource = (d) => /\bisSquare\b|\bradius\b|imageContainerStyle\.borderRadius/.test(d)
    const ok = deps.length > 0 && deps.every(shapeSource)
    add(
      'invariant 5: 含 borderRadius 的 useMemo 依赖数组含 isSquare 或 radius（形状真值来源）',
      ok,
      deps.length ? deps.map((d) => `[${d.trim()}]`).join(' ') : '未找到含 borderRadius 的 useMemo',
    )
  }

  // 6. 设置组件：写入 'square' / 'circle'，且说明文案真被引用
  {
    const writesSquare = /'playDetail\.style\.coverShape':\s*isOn\s*\?\s*'square'\s*:\s*'circle'/.test(
      stripComments(REAL.setting),
    )
    const hasDesc = /t\(['"]play_detail_setting_cover_shape_desc['"]\)/.test(stripComments(REAL.setting))
    const descExists = lang['play_detail_setting_cover_shape_desc'] != null &&
      lang['play_detail_setting_cover_shape_desc'] !== ''
    const descSaysNoSpin = /不旋转/.test(String(lang['play_detail_setting_cover_shape_desc'] ?? ''))
    add(
      'invariant 6: 设置组件写入 square/circle，且「不旋转」被写进说明文案（文案不得与实现脱节）',
      writesSquare && hasDesc && descExists && descSaysNoSpin,
      `写值=${writesSquare} 引用文案=${hasDesc} 词条存在=${descExists} 含「不旋转」=${descSaysNoSpin}`,
    )
  }

  // 11. **圆角单一真值来源**：形状只由 coverShape 推导，两层二次覆盖都要拦住 ——
  //     ① 全局「按钮圆角」（useButtonRadius / buttonRadius(n)）：默认值 0 = 直角，
  //        接上就等于把封面形状交给一个默认关闭的设置；
  //     ② 行内字面量（`borderRadius: 0` 之类，不管是写在样式对象里还是 JSX 数组里）：
  //        会让 `isSquare ? … : …` 这条分支被旁路，切形状后毫无变化。
  //     历史上竖屏三层、横屏三层各带一处行内 `borderRadius: buttonRadius(40)`，
  //     合起来把「圆形封面」渲染成直角方块 —— 契约必须能挡住它重来。
  {
    const noHook = !/\buseButtonRadius\b/.test(code) && !/\bbuttonRadius\s*\(/.test(code)
    // 字面量：数字或字符串形式的 borderRadius（`radius` / `imageContainerStyle.borderRadius` 这类
    // 由 coverShape 推导的写法不算 —— 它们正是期望的唯一来源）。
    const noLiteral = !/borderRadius\s*:\s*(?:\d|['"])/.test(code)
    // JSX 行内数组里叠加 borderRadius（`style={[x, { borderRadius: 0 }]}` / `style={[x, { borderRadius: y }]}`）。
    // `[^\]]*` 到本数组的第一个 `]` 为止：横屏 `style={[styles.content, imageContainerStyle, { overflow: 'hidden' }]}`
    // 这类合法写法碰不到 borderRadius，不会误报。
    const noInlineArray = !/style=\{\[[^\]]*\bborderRadius\b/.test(code)
    add(
      'invariant 11: 圆角无二次覆盖（不接全局按钮圆角、无行内字面量、无 JSX 数组内叠加）',
      noHook && noLiteral && noInlineArray,
      `无按钮圆角引用=${noHook} 无字面量=${noLiteral} 无 JSX 数组内叠加=${noInlineArray}`,
    )
  }

  // 12. **可见性门控在位**：自转必须由「播放态 × 可见性」共同决定。
  //     方形封面的「不旋转」正是靠这条链路生效的一半（另一半是圆角）：只把 allowSpin 接上、
  //     却把可见性从启停分支里拿掉，就会回到「不可见时原生动画仍逐帧驱动」（纯白烧电）。
  //     竖屏还有第二条可见性来源「封面页是 PagerView 当前页」（active prop，由 VerticalNew 下传）；
  //     横屏无分页（左栏常驻），可见性只有屏幕是否被压栈页覆盖一个来源。
  {
    const covered = /useScreenCovered\s*\(/.test(code)
    // 启停分支里必须真的**分支**到 spinVisible（不是只在别处 && 一下）：
    // 形如 `if (spinVisible) startAnimation()` + 对应的停驱动分支。
    const branches = /if\s*\(\s*spinVisible\s*\)/.test(code) && /else\s+stopAnimation\(\)/.test(code)
    // 有 active prop 的组件（竖屏）必须让它参与可见性判定
    const hasActiveProp = /active\s*=\s*true/.test(code)
    const activeInGate = !hasActiveProp || /spinVisible\s*=\s*active\s*&&\s*!screenCovered/.test(code)
    add(
      'invariant 12: 可见性参与启停（useScreenCovered + spinVisible 分支；有 active prop 时必须合流）',
      covered && branches && activeInGate,
      `用 useScreenCovered=${covered} 启停分支=${branches} active 合流=${activeInGate}`,
    )
  }

  return out
}

/** 全局不变量：默认值 / 类型 / 弹层注册 / 文案（与组件无关，只跑一次） */
function globalInvariants() {
  const out = []
  const add = (n, ok, detail = '') => out.push({ name: n, ok, detail })

  {
    const hasKey = /'playDetail\.style\.coverShape':\s*'circle'/.test(REAL.defaults)
    add(
      "invariant 7: defaultSetting 有 'playDetail.style.coverShape' 且默认 'circle'（保持既有观感）",
      hasKey,
    )
  }

  {
    const decl = /'playDetail\.style\.coverShape':\s*'circle'\s*\|\s*'square'/.test(REAL.types)
    add("invariant 8: 类型声明为 'circle' | 'square'（与 defaultSetting 字面量一致）", decl)
  }

  {
    const imported = /import\s+SettingCoverShape\s+from/.test(REAL.popup)
    const rendered = /<SettingCoverShape\s*\/>/.test(REAL.popup)
    add('invariant 9: 弹层已 import 并渲染 <SettingCoverShape />', imported && rendered,
      `import=${imported} render=${rendered}`)
  }

  {
    const label = REAL.lang['play_detail_setting_cover_shape']
    add('invariant 10: 词条 play_detail_setting_cover_shape 存在（否则开关无文字，UI 空白）',
      label != null && label !== '', String(label ?? '缺失'))
  }

  return out
}

/** 反例：把篡改后的源码喂回**同一套** coverInvariants，必须真的被拦下 */
function tamperCases(src) {
  // 竖屏写成命名常量、横屏写成字面量 4；两种形态都要能挂上反例
  const radiusRe = /const radius = isSquare \? (SQUARE_RADIUS|\d+) : (size|imgWidth) \/ 2/
  // ⑪ 的锚点：封面元素的行内 style 引用（竖屏 animatedCoverStyle / 横屏 imageStyle）。
  const coverStyleRe = /style=\{(?:animatedCoverStyle|imageStyle)\}/
  if (!src.includes('const allowSpin = isCoverSpin && !isSquare') || !radiusRe.test(src) || !coverStyleRe.test(src)) {
    throw new Error('反例锚点未命中：源码已变，反例需同步')
  }
  return [
    {
      label: '① 只改圆角、不关旋转（方形仍会转 —— 最危险的一半）',
      mutate: (s) => s.replace(
        'const allowSpin = isCoverSpin && !isSquare',
        'const allowSpin = isCoverSpin',
      ),
    },
    {
      label: '② 只关旋转、不改圆角（方形看不出是方形）',
      mutate: (s) => s.replace(/const radius = isSquare \? (?:SQUARE_RADIUS|\d+) : (size|imgWidth) \/ 2/,
        'const radius = $1 / 2'),
    },
    {
      label: '③ 圆角判断反了（圆形取小圆角、方形取半径）',
      mutate: (s) => s.replace(/const radius = isSquare \? (SQUARE_RADIUS|\d+)/,
        'const radius = !isSquare ? $1'),
    },
    {
      // 两种写法都要能挂上：横屏依赖 isSquare、竖屏依赖 radius（由 isSquare 推导）。
      // 抹掉形状真值来源后，依赖数组里只剩 size/spin 之类的「非形状」项。
      label: '④ 依赖数组漏掉形状真值来源（切形状后圆角不重算）',
      mutate: (s) => s
        .replace(/(\},\s*\[winWidth, winHeight, statusBarHeight, )isSquare(, coverSize, layout\])/, '$1$2')
        .replace(/(\} as any\), \[size, )radius(, spin\])/, '$1$2'),
    },
    {
      // 用正则而不是裸字符串：gate 行将来若带上附加条件（如 `&& !screenCovered`），
      // 裸字符串会「替换未命中」而把这条反例变成假红/空转，正则仍能咬住。
      label: '⑤ 动画门控退回 isCoverSpin（等于没关旋转）',
      mutate: (s) => s.replace(/if\s*\(isPlay && allowSpin([^)]*)\)\s*\{/, 'if (isPlay && isCoverSpin$1) {'),
    },
    {
      label: '⑥ 把 allowSpin 定义注释掉（去注释后必须失效）',
      mutate: (s) => s.replace('const allowSpin = isCoverSpin && !isSquare',
        '// const allowSpin = isCoverSpin && !isSquare'),
    },
    {
      // 复现历史 bug 的形状：在封面元素的行内 style 上再叠一层 borderRadius 写字面量
      //（原文就是 `borderRadius: buttonRadius(40)`，全局按钮圆角默认 0 ⇒ 圆形封面被压成直角）。
      // 这里用字面量 0 而不是重引 buttonRadius：字面量更难被「只查 hook 引用」的守卫漏掉，
      // 拦住它就同时证明了 invariant 11 的两条路（无 hook 引用 / 无行内字面量）都在岗。
      label: '⑪ 封面行内 style 再叠一层 borderRadius 字面量（形状设置被旁路，历史 bug 复现）',
      mutate: (s) => s.replace(coverStyleRe, (m) => `style={[${m.slice('style={'.length, -1)}, { borderRadius: 0 }]}`),
    },
    {
      // 去掉「不可见时停驱动」那一支：门控只剩播放态 ⇒ 滑到歌词页 / 被压栈页盖住后
      // 原生动画仍逐帧驱动（纯白烧电），且恢复可见时相位语义也一并丢失。
      label: '⑫ 启停分支丢掉可见性（不可见时仍继续转 = 空烧电）',
      mutate: (s) => s.replace(
        /if\s*\(\s*spinVisible\s*\)\s*startAnimation\(\)\s*\n\s*else\s+stopAnimation\(\)/,
        'startAnimation()',
      ),
    },
  ]
}

// ---------- 主流程 ----------
const results = []
const push = (r) => results.push(r)

for (const [label, file, src] of [
  ['竖屏 Pic', VERTICAL, REAL.vertical],
  ['横屏 Pic', HORIZONTAL, REAL.horizontal],
]) {
  for (const r of coverInvariants(label, src, REAL.lang)) push({ group: '不变量', ...r })

  for (const c of tamperCases(src)) {
    const patched = c.mutate(src)
    if (patched === src) {
      push({
        group: '反例',
        name: `${label} · 反例 ${c.label}`,
        ok: false,
        detail: '替换未命中：源码已变，反例失效需同步',
      })
      continue
    }
    const failed = coverInvariants(label, patched, REAL.lang).filter((r) => !r.ok)
    push({
      group: '反例',
      name: `${label} · 反例 ${c.label} 被拦下`,
      ok: failed.length > 0,
      detail: failed.length
        ? `命中：${failed.map((r) => r.name.split('· ')[1].split(':')[0]).join('、')}`
        : '未被任何不变量拦下（守卫无效）',
    })
  }
}

for (const r of globalInvariants()) push({ group: '不变量', ...r })

// 全局反例：默认值改错、类型漏 square、弹层未注册、文案与实现脱节
{
  const g = [
    {
      label: '⑦ defaultSetting 默认值改成 square（会悄悄改掉所有用户的既有观感）',
      run: () => {
        const patched = { ...REAL, defaults: REAL.defaults.replace(
          "'playDetail.style.coverShape': 'circle'", "'playDetail.style.coverShape': 'square'") }
        return patched
      },
    },
    {
      label: '⑧ 类型声明漏掉 square（与 defaultSetting 字面量脱节）',
      run: () => ({ ...REAL, types: REAL.types.replace(/'circle'\s*\|\s*'square'/, "'circle'") }),
    },
    {
      label: '⑨ 弹层未渲染 <SettingCoverShape />（开关根本点不到）',
      run: () => ({ ...REAL, popup: REAL.popup.replace('<SettingCoverShape />', '') }),
    },
    {
      // 注意：必须真的把「不旋转」抹掉。第一版替换串漏了原文里的「，且」，
      // replace 未命中 → 值没变 → 反例 ⑩ 假绿（守卫自身没有生效）。
      label: '⑩ 文案删掉「不旋转」（说明与实现脱节，用户以为能叠着开）',
      run: () => ({
        ...REAL,
        lang: {
          ...REAL.lang,
          'play_detail_setting_cover_shape_desc':
            String(REAL.lang['play_detail_setting_cover_shape_desc'] ?? '').replace(/不旋转/g, ''),
        },
      }),
    },
  ]
  for (const c of g) {
    const patch = c.run()
    const changed = Object.keys(patch).some((k) => patch[k] !== REAL[k])
    if (!changed) {
      push({ group: '反例', name: `反例 ${c.label}`, ok: false, detail: '替换未命中：源码已变' })
      continue
    }
    // 临时把 REAL 换成 patch，把**全局**与**组件级**两套不变量都跑一遍
    // （文案断言 invariant 6 住在组件级那套里，只跑全局会漏判 —— 反例 ⑩ 第一版就这么假绿的）
    const saved = { ...REAL }
    Object.assign(REAL, patch)
    const failed = [
      ...globalInvariants(),
      ...coverInvariants('竖屏 Pic', REAL.vertical, REAL.lang),
      ...coverInvariants('横屏 Pic', REAL.horizontal, REAL.lang),
    ].filter((r) => !r.ok)
    Object.assign(REAL, saved)
    push({
      group: '反例',
      name: `反例 ${c.label} 被拦下`,
      ok: failed.length > 0,
      detail: failed.length
        ? `命中：${failed.map((r) => r.name.split(':')[0]).join('、')}`
        : '未被任何不变量拦下（守卫无效）',
    })
  }
}

// ---------- 输出 ----------
let pass = 0
let fail = 0
let lastGroup = ''
for (const r of results) {
  if (r.group !== lastGroup) {
    console.log(`\n--- ${r.group} ---`)
    lastGroup = r.group
  }
  if (r.ok) {
    pass++
    console.log(`  PASS  ${r.name}`)
  } else {
    fail++
    console.log(`  FAIL  ${r.name}`)
  }
  if (r.detail) console.log(`        ${r.detail}`)
}

console.log('\n' + '='.repeat(70))
console.log(`结果：${pass} 通过 / ${fail} 失败`)
console.log('='.repeat(70))
process.exit(fail ? 1 : 0)
