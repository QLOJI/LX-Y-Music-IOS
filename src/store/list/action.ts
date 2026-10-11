import state, { type InitState } from './state'

export default {
  setUserLists(userList: LX.List.UserListInfo[]) {
    state.userList = userList
    state.allList = [state.defaultList, state.loveList, ...state.userList]

    global.state_event.mylistUpdated(state.allList)
  },
  setActiveList(activeListId: string) {
    state.activeListId = activeListId

    global.state_event.mylistToggled(activeListId)
  },
  setTempListMeta(meta: InitState['tempListMeta']) {
    state.tempListMeta = meta
  },
  setFetchingListStatus(id: string, status: boolean) {
    state.fetchingListStatus[id] = status

    global.state_event.fetchingListStatusUpdated({ ...state.fetchingListStatus })
  },
}

// })

// export const selectActiveListId = (state: LX.State) => state.userList.activeListId

// export default slice.reducer
