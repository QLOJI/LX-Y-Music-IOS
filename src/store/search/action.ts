import state, { type InitState } from './state'

export default {
  setSearchType(type: InitState['searchType']) {
    state.searchType = type
  },
  setSearchText(text: string) {
    state.searchText = text
  },
  setTipListInfo(
    keyword: InitState['tipListInfo']['text'],
    source: InitState['tipListInfo']['source'],
  ) {
    state.tipListInfo.text = keyword
    state.tipListInfo.source = source
  },
  setTipList(list: InitState['tipListInfo']['list']) {
    state.tipListInfo.list = list
  },
  setHistoryWord(list: string[]) {
    state.historyList = list
  },
  addHistoryWord(word: string) {
    let index = state.historyList.indexOf(word)
    if (index == 0) return
    if (index > -1) state.historyList.splice(index, 1)
    if (state.historyList.length >= 15) state.historyList.splice(14, state.historyList.length - 14)
    state.historyList.unshift(word)
    return [...state.historyList]
  },
  removeHistoryWord(index: number) {
    state.historyList.splice(index, 1)
    return [...state.historyList]
  },
  clearHistoryList() {
    state.historyList = []
    return state.historyList
  },
}
