/**
 * sim-cover-download.js
 *
 * 「封面下载 / 保存图片」契约不变量（第 21 轮·优化 2）。
 *
 * 用户报的 bug：长按播放详情页封面点「下载封面」无效 —— 提示「正在下载封面…」之后
 * 既没有文件也不报错，因为三处各自「成功」了：
 *   ① `src/utils/rnFetchBlob.ts` 的 `fetch` 是**占位实现**（直接 resolve 一个空壳），
 *      调用方 await 完以为下好了，磁盘上什么都没有；
 *   ② 真正落到的是应用沙盒的 Pictures 目录，用户在系统相册里永远看不到；
 *   ③ 这段菜单内联在竖屏 Pic.tsx 里，横屏封面压根没有长按入口。
 *
 * 本脚本把这条链上的每一环钉住（任何一环松掉，症状都会重演）：
 *   ① shim 必须真下载（http(s) → downloadFile / file:// → copyFile / 失败必抛 /
 *      落盘前删同目标文件 / 非 GET 直接报错）；
 *   ② shim 补的 UA 与 fs.ios.ts 的默认 UA 逐字一致，且不得自带 progressInterval
 *      （否则会把 fs.ios.ts 的统一限流覆盖掉）；
 *   ③ `utils/image.ts` iOS 分支：下到缓存临时文件 → 原生写相册 → **finally 删临时文件**；
 *   ④ 原生 `UtilsModule.saveImageToPhotosLibrary`（PHPhotoLibrary performChanges +
 *      PHAssetChangeRequest）+ Info.plist 的 NSPhotoLibraryAddUsageDescription +
 *      工程链上 Photos.framework —— 三者缺一，真机上要么没权限弹窗、要么链接失败；
 *   ⑤ JS 包装三态（true / false / null）—— null 专门表示「原生方法不可用」，
 *      调用方据此回退到沙盒落盘，旧构建上不会崩；
 *   ⑥ 长按菜单**唯一实现**在 PlayDetail/components/CoverLongPressMenu.tsx，
 *      竖屏与横屏都接它，竖屏不得再残留内联实现；
 *   ⑦ 保存结果的提示统一由 saveImageToPictures 的返回值分流（savedToPhotos），
 *      不得再出现「写进沙盒路径就算成功」的硬编码文案。
 *
 * 运行：node scripts/sim-cover-download.js
 * 退出码：全部不变量通过、且每条反例都被拦下时为 0，否则 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const FILES = {
  shim: 'src/utils/rnFetchBlob.ts',
  fsIos: 'src/utils/fs.ios.ts',
  image: 'src/utils/image.ts',
  nativeUtils: 'src/utils/nativeModules/utils.ts',
  previewModal: 'src/components/common/ImagePreviewModal.tsx',
  menu: 'src/screens/PlayDetail/components/CoverLongPressMenu.tsx',
  verticalPic: 'src/screens/PlayDetail/Vertical/Pic.tsx',
  horizontalPic: 'src/screens/PlayDetail/Horizontal/Pic.tsx',
  appDelegate: 'ios/LxMusicMobile/AppDelegate.mm',
  infoPlist: 'ios/LxMusicMobile/Info.plist',
  pbxproj: 'ios/LxMusicMobile.xcodeproj/project.pbxproj',
}

const REAL = {}
for (const key of Object.keys(FILES)) REAL[key] = read(FILES[key])

/**
 * 去行注释与块注释：否则「把代码注释掉」的篡改会被当成仍然存在（历史踩过的坑）。
 * 但 `//` 前面是 `:`（file:// / https://）、引号或转义反斜杠时不算注释 —— 朴素的
 * 「从 `//` 砍到行尾」写法则会把 `'file://'` 从中间截断，于是 shim 里明明写着的
 * `url.startsWith('file://')` 在源码正确时被判成不存在（同 scripts/sim-tap-lock-responder.js）。
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')

const count = (src, re) => [...src.matchAll(re)].length

/** 全部不变量。files = 取值同 REAL 的一次快照（反例跑的是篡改后的快照）。 */
function invariants(files) {
  const out = []
  const add = (name, ok, detail = '') => out.push({ name, ok, detail })

  const shim = stripComments(files.shim)
  const fsIos = stripComments(files.fsIos)
  const image = stripComments(files.image)
  const nativeUtils = stripComments(files.nativeUtils)
  const preview = stripComments(files.previewModal)
  const menu = stripComments(files.menu)
  const vertical = stripComments(files.verticalPic)
  const horizontal = stripComments(files.horizontalPic)
  const appDelegate = stripComments(files.appDelegate)

  // ---- ① shim 必须是真下载 ----
  {
    // 占位实现的指纹：`Promise.resolve({ path: () => opts.path …, base64: async() => '' })`
    const placeholder = /Promise\.resolve\(\{\s*path:\s*\(\)\s*=>\s*opts\.path/.test(shim)
    const usesDownloadFile = /downloadFile\(url,\s*targetPath/.test(shim)
    const fileBranch = /url\.startsWith\('file:\/\/'\)/.test(shim) && /copyFile\(url,\s*targetPath\)/.test(shim)
    const rejectsNonGet = /method\.toUpperCase\(\)\s*!=\s*'GET'/.test(shim) && /只实现了 GET/.test(shim)
    const deletesBeforeWrite = count(shim, /await unlink\(targetPath\)\.catch\(\(\) => \{\}\)/g) >= 2
    const throwsOnFailure = /throw new Error\(`下载失败/.test(shim)
    const verifiesWritten = /文件未写入磁盘/.test(shim)
    const realBase64 = /base64:\s*async\(\)\s*=>\s*readFile\(targetPath,\s*'base64'\)/.test(shim)
    add(
      '① shim 真下载：非占位 + downloadFile/copyFile 双分支 + 非 GET 报错 + 落盘前删旧文件 + 失败必抛 + 校验已写入 + base64 读真实文件',
      !placeholder && usesDownloadFile && fileBranch && rejectsNonGet && deletesBeforeWrite &&
        throwsOnFailure && verifiesWritten && realBase64,
      `占位=${placeholder} downloadFile=${usesDownloadFile} file分支=${fileBranch} 非GET报错=${rejectsNonGet} ` +
        `删旧文件=${deletesBeforeWrite} 失败抛错=${throwsOnFailure} 校验写入=${verifiesWritten} base64=${realBase64}`,
    )
  }

  // ---- ② UA 与限流：两处 UA 逐字一致；shim 不得自带 progressInterval ----
  {
    const uaLiteral = (src) => {
      const m = /Mozilla\/5\.0 \(iPhone[^']+/.exec(src)
      return m ? m[0] : null
    }
    const shimUa = uaLiteral(shim)
    const fsUa = uaLiteral(fsIos)
    const sameUa = shimUa != null && fsUa != null && shimUa === fsUa
    const defaultApplied = /if\s*\(!hasUserAgent\)\s*merged\['User-Agent'\]\s*=\s*DEFAULT_USER_AGENT/.test(shim)
    const noProgressOverride = !/progressInterval/.test(shim)
    const throttled = /progressInterval:\s*DOWNLOAD_PROGRESS_INTERVAL/.test(fsIos)
    add(
      '② UA 与限流：shim 与 fs.ios.ts 的 UA 字面量逐字一致（有 headers 时也要带 UA）+ shim 不覆盖 progressInterval + fs.ios.ts 仍统一限流 250ms',
      sameUa && defaultApplied && noProgressOverride && throttled,
      `UA 一致=${sameUa} 补默认UA=${defaultApplied} shim无progressInterval=${noProgressOverride} 限流在位=${throttled}`,
    )
  }

  // ---- ③ image.ts：iOS 走相册 + finally 删临时文件 ----
  {
    const iosBranch = /if\s*\(Platform\.OS\s*==\s*'ios'\)\s*return saveToPhotosOnIOS\(/.test(image)
    const loadsNative = /import\s*\{\s*saveImageToPhotosLibrary\s*\}\s*from\s*'@\/utils\/nativeModules\/utils'/.test(image)
    const callsNative = /saveImageToPhotosLibrary\(tmpPath\)/.test(image)
    const finallyUnlink = /finally\s*\{\s*await unlink\(tmpPath\)\.catch\(\(\) => \{\}\)/.test(image)
    const threeState = /saved\s*===\s*true/.test(image) && /saved\s*===\s*null/.test(image)
    const returnsFlag = /savedToPhotos:\s*true/.test(image) && /savedToPhotos:\s*false/.test(image)
    add(
      '③ image.ts：iOS 分支走相册（原生包装 import/调用 + true/null 三态分流）且 finally 删缓存临时文件（成功失败都不留）',
      iosBranch && loadsNative && callsNative && finallyUnlink && threeState && returnsFlag,
      `iOS 分支=${iosBranch} import=${loadsNative} 调原生=${callsNative} finally 删除=${finallyUnlink} ` +
        `三态=${threeState} 返回标记=${returnsFlag}`,
    )
  }

  // ---- ④ 原生实现 + plist 权限 + 工程链接 ----
  {
    const impl = /RCT_REMAP_METHOD\(saveImageToPhotosLibrary,/.test(appDelegate)
    const performChanges = /\[\[PHPhotoLibrary sharedPhotoLibrary\] performChanges:\^\{/.test(appDelegate)
    const assetRequest = /\[PHAssetChangeRequest creationRequestForAssetFromImageAtFileURL:/.test(appDelegate)
    const addOnly = /requestAuthorizationForAccessLevel:PHAccessLevelAddOnly/.test(appDelegate)
    const legacyAuth = /\[PHPhotoLibrary requestAuthorization:\^/.test(appDelegate)
    const importPhotos = /#import <Photos\/Photos\.h>/.test(files.appDelegate)
    const plistKey = /<key>NSPhotoLibraryAddUsageDescription<\/key>/.test(files.infoPlist)
    // 工程里 Photos.framework 必须四处齐全：PBXBuildFile 定义 / PBXFileReference 定义 /
    // Frameworks 构建阶段的 files 列表 / Frameworks 组的 children 列表。
    // （不数 "Photos.framework" 字面量出现次数：PBXFileReference 一行里 name 与 path 各一次，
    //   行数固定但次数会随写法变，按四处锚点判更稳。）
    const pbxBuildFile = /[0-9A-F]{16,} \/\* Photos\.framework in Frameworks \*\/ = \{isa = PBXBuildFile;/.test(files.pbxproj)
    const pbxFileRef = /[0-9A-F]{16,} \/\* Photos\.framework \*\/ = \{isa = PBXFileReference;[^}]*Photos\.framework;/.test(files.pbxproj)
    const pbxInPhase = /[0-9A-F]{16,} \/\* Photos\.framework in Frameworks \*\/,/.test(files.pbxproj)
    const pbxInGroup = /[0-9A-F]{16,} \/\* Photos\.framework \*\/,/.test(files.pbxproj)
    add(
      '④ 原生：saveImageToPhotosLibrary（performChanges + PHAssetChangeRequest，AddOnly 授权、兼容旧系统）+ Info.plist 新增说明 + 工程四处锚点链接 Photos.framework',
      impl && performChanges && assetRequest && addOnly && legacyAuth && importPhotos && plistKey &&
        pbxBuildFile && pbxFileRef && pbxInPhase && pbxInGroup,
      `原生方法=${impl} performChanges=${performChanges} PHAssetChangeRequest=${assetRequest} ` +
        `AddOnly=${addOnly} 旧系统兜底=${legacyAuth} import=${importPhotos} plist 键=${plistKey} ` +
        `pbxproj[buildFile=${pbxBuildFile} fileRef=${pbxFileRef} 构建阶段=${pbxInPhase} 分组=${pbxInGroup}]`,
    )
  }

  // ---- ⑤ JS 包装三态：方法不存在 → null（调用方回退），异常 → false ----
  {
    const declared = /export const saveImageToPhotosLibrary = async\(filePath: string\): Promise<boolean \| null>/.test(nativeUtils)
    const nullWhenMissing = /typeof UtilsModule\?\.saveImageToPhotosLibrary != 'function'\)\s*return null/.test(nativeUtils)
    const catchesToFalse = /catch\s*\{[\s\S]{0,60}?return false/.test(nativeUtils)
    const trueOnlyWhenTrue = /return result === true/.test(nativeUtils)
    add(
      '⑤ JS 包装：非 iOS / 方法不存在返回 null（旧构建回退沙盒），异常折算 false，只有 === true 才算成功',
      declared && nullWhenMissing && catchesToFalse && trueOnlyWhenTrue,
      `声明=${declared} 缺失→null=${nullWhenMissing} 异常→false=${catchesToFalse} 严格判真=${trueOnlyWhenTrue}`,
    )
  }

  // ---- ⑥ 菜单唯一实现，横竖屏都接，竖屏不留内联 ----
  {
    const menuHasItems = /download_song/.test(menu) && /download_pic/.test(menu) &&
      /'下载歌曲'/.test(menu) && /'下载封面'/.test(menu)
    const menuUsesSharedSave = /saveImageToPictures\(picUrl/.test(menu) && /getPicUrl\(\{ musicInfo:/.test(menu)
    const menuNoSandboxWrite = !/RNFetchBlob|PictureDir|mkdir\(/.test(menu)
    const menuMeasuresAnchor = /anchor\.measure\(/.test(menu) && /anchorRef/.test(menu)
    const verticalUses = /<CoverLongPressMenu ref=\{menuRef\} anchorRef=\{coverRef\} musicInfo=\{menuMusicInfo\}/.test(vertical)
    const verticalNoInline = !/RNFetchBlob|getPicUrl|download_pic|config\(\{ path/.test(vertical)
    const horizontalUses = /<CoverLongPressMenu ref=\{menuRef\} anchorRef=\{coverRef\} musicInfo=\{playMusicInfo\.musicInfo\}/.test(horizontal)
    const horizontalLongPress = /<TouchableWithoutFeedback onLongPress=\{handleLongPress\}>/.test(horizontal) &&
      /menuRef\.current\?\.show\(\)/.test(horizontal)
    const horizontalAnchor = /ref=\{coverRef\}/.test(horizontal) && /collapsable=\{false\}/.test(horizontal)
    add(
      '⑥ 长按菜单唯一实现（含两个菜单项 + 锚点实测 + 保存走 image.ts）+ 竖屏接入且无内联 + 横屏新增长按入口（含锚点 View）',
      menuHasItems && menuUsesSharedSave && menuNoSandboxWrite && menuMeasuresAnchor &&
        verticalUses && verticalNoInline && horizontalUses && horizontalLongPress && horizontalAnchor,
      `菜单项=${menuHasItems} 共用保存=${menuUsesSharedSave} 无沙盒写入=${menuNoSandboxWrite} 锚点实测=${menuMeasuresAnchor} ` +
        `竖屏接入=${verticalUses} 竖屏无内联=${verticalNoInline} 横屏接入=${horizontalUses} ` +
        `横屏长按=${horizontalLongPress} 横屏锚点=${horizontalAnchor}`,
    )
  }

  // ---- ⑦ 结果提示按 savedToPhotos 分流，失败不静默 ----
  {
    const previewBranches = /result\.savedToPhotos \? '已保存到相册'/.test(preview)
    const menuBranches = /result\.savedToPhotos \? '封面已保存到相册'/.test(menu)
    const menuAbortsOnNull = /if \(!result\) return/.test(menu)
    const menuToastsError = /toast\(`下载封面失败: \$\{err/.test(menu)
    const imageToastsError = /toast\(`保存图片失败: \$\{err/.test(image)
    add(
      '⑦ 提示分流：相册成功 → 「已保存到相册」，否则显示落盘路径兜底；失败必 toast（不再有静默假成功）',
      previewBranches && menuBranches && menuAbortsOnNull && menuToastsError && imageToastsError,
      `预览分流=${previewBranches} 菜单分流=${menuBranches} null 直接返回=${menuAbortsOnNull} ` +
        `菜单报错=${menuToastsError} image 报错=${imageToastsError}`,
    )
  }

  return out
}

// ---------- 反例 ----------
const tamperCases = [
  {
    label: '① shim 退回占位实现（静默 resolve，磁盘上什么都不写 = 用户报的原 bug）',
    file: 'shim',
    mutate: (s) => s.replace(
      /async fetch\([\s\S]*?\n  \},\n\}\)/,
      'async fetch(_method: string, _url: string): Promise<FetchResult> {\n' +
      "    return Promise.resolve({ path: () => opts.path ?? '', base64: async() => Promise.resolve('') })\n" +
      '  },\n}),',
    ),
  },
  {
    label: '② shim 丢掉 file:// 分支（本地封面被当网络地址下载，必然失败）',
    file: 'shim',
    mutate: (s) => s.replace(/if \(url\.startsWith\('file:\/\/'\)\) \{/, 'if (false) {'),
  },
  {
    label: '③ shim 落盘前不删同目标文件（旧文件残留 / RNFS 直接报错）',
    file: 'shim',
    mutate: (s) => s.replace(/await unlink\(targetPath\)\.catch\(\(\) => \{\}\)/g, 'await Promise.resolve()'),
  },
  {
    label: '④ shim 的 UA 与 fs.ios.ts 不一致（带 headers 的请求丢 UA，封面 CDN 返 403）',
    file: 'shim',
    mutate: (s) => s.replace("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0", 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0'),
  },
  {
    label: '⑤ image.ts 不删缓存临时文件（每存一张封面留一份整图）',
    file: 'image',
    mutate: (s) => s.replace(/\n  \} finally \{\n    await unlink\(tmpPath\)\.catch\(\(\) => \{\}\)\n  \}/, ''),
  },
  {
    label: '⑥ Info.plist 缺 NSPhotoLibraryAddUsageDescription（写相册当场崩/被系统拒绝）',
    file: 'infoPlist',
    mutate: (s) => s.replace(/\s*<key>NSPhotoLibraryAddUsageDescription<\/key>\s*\n\s*<string>[^<]*<\/string>/, ''),
  },
  {
    label: '⑦ 横屏封面的长按入口被拿掉（回到「横屏没有下载封面」）',
    file: 'horizontalPic',
    mutate: (s) => s.replace('<TouchableWithoutFeedback onLongPress={handleLongPress}>', '<View>')
      .replace(/<\/TouchableWithoutFeedback>/, '</View>'),
  },
  {
    label: '⑧ 菜单的「下载封面」改回自己写沙盒 Pictures（用户相册里还是看不到）',
    file: 'menu',
    mutate: (s) => s
      .replace(/const result = await saveImageToPictures\(picUrl[^\n]*\n/, '')
      .replace(/if \(!result\) return/, '')
      .replace(
        /toast\(result\.savedToPhotos \? '封面已保存到相册' : `封面已保存到: \$\{result\.path\}`, 'long'\)/,
        "await RNFetchBlob.config({ path: `${PictureDir}/LX-N-Music/x.jpg` }).fetch('GET', picUrl)\n            toast(`封面已保存到: ${PictureDir}`, 'long')",
      ),
  },
]

// ---------- 主流程 ----------
const results = []
for (const r of invariants(REAL)) results.push({ group: '不变量', ...r })

for (const c of tamperCases) {
  const patched = { ...REAL, [c.file]: c.mutate(REAL[c.file]) }
  if (patched[c.file] === REAL[c.file]) {
    results.push({
      group: '反例',
      name: `反例 ${c.label}`,
      ok: false,
      detail: '替换未命中：源码已变，反例失效需同步',
    })
    continue
  }
  const failed = invariants(patched).filter((r) => !r.ok)
  results.push({
    group: '反例',
    name: `反例 ${c.label} 被拦下`,
    ok: failed.length > 0,
    detail: failed.length
      ? `命中：${failed.map((r) => r.name.split('：')[0]).join('、')}`
      : '未被任何不变量拦下（守卫无效）',
  })
}

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
console.log(`结果：断言 ${pass}/${pass + fail} 通过；反例 ${tamperCases.length - results.filter((r) => r.group === '反例' && !r.ok).length}/${tamperCases.length} 拦下`)
console.log('='.repeat(70))
process.exit(fail ? 1 : 0)
