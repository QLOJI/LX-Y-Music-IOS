import zh_cn from './zh-cn.json'
import zh_tw from './zh-tw.json'
import en_us from './en-us.json'

// 三份语言包的键集合与 zh-cn 完全一致（缺键在构建时补齐，见本轮的合并脚本）。
type Message = Record<keyof typeof zh_cn, string>

const langs = [
  {
    name: '简体中文',
    locale: 'zh_cn',
    // alternate: 'zh-hans',
    country: 'cn',
    fallback: true,
    message: zh_cn,
  },
  {
    name: '繁體中文',
    locale: 'zh_tw',
    // alternate: 'zh-hant',
    country: 'cn',
    message: zh_tw,
  },
  {
    name: 'English',
    locale: 'en_us',
    country: 'us',
    message: en_us,
  },
] as const

const langList: Array<{
  name: string
  locale: (typeof langs)[number]['locale']
  // alternate?: string
}> = []
type Messages = Record<(typeof langs)[number]['locale'], Message>

// @ts-expect-error
const messages: Messages = {}

langs.forEach((item) => {
  langList.push({
    name: item.name,
    locale: item.locale,
    // alternate: item.alternate,
  })
  messages[item.locale] = item.message
})

export { langList, messages }

export type { Messages, Message }

export * from './i18n'
