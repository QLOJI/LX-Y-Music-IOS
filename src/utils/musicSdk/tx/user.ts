/**
 * QQ Music user API module
 * Based on QQMusicApi-source project implementation
 * Used to fetch user playlists, collected playlists, collected music, etc.
 */

import { httpFetch } from '../../request'
import settingState from '@/store/setting/state'
import { txLog } from '@/utils/txLog'
import { zzcSign, zzcSignV2 } from './utils/crypto'
import { encodeAG1Request, decodeAG1Response } from './utils/ag1'
import { log as errorLog } from '@/utils/log'
import getMusicInfo from './musicInfo'

const TX_API_HOST = 'c.y.qq.com'
const TX_MUSIC_U_FCG = 'https://u.y.qq.com/cgi-bin/musics.fcg'
const TX_MUSIC_U = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
// 「我喜欢」写接口（needSign）固定走 u6 的 ag-1 加密通道。
const TX_MUSIC_U_FCG_AG1 = 'https://u6.y.qq.com/cgi-bin/musics.fcg'

const qqHash33 = (value: string, seed = 5381) => {
  let hash = seed
  for (const char of String(value || '')) {
    hash = ((hash << 5) + hash + char.charCodeAt(0)) & 0x7fffffff
  }
  return hash
}

export default {
  /**
   * Extract uin from Cookie
   * Supports QQ login (uin=xxx) and WeChat login (wxUin=xxx or wxuin=xxx)
   */
  extractUin(cookie: string): string | null {
    if (!cookie) return null

    // QQ login: uin=xxx
    const uinMatch = cookie.match(/(?:^|;)\s*uin=(\d+|o[A-Za-z0-9_-]+)/)
    if (uinMatch) {
      return uinMatch[1]
    }

    // WeChat login: wxUin=xxx or wxuin=xxx
    const wxUinMatch = cookie.match(/(?:^|;)\s*(?:wxUin|wxuin)=(\d+|[A-Za-z0-9_-]+)/i)
    if (wxUinMatch) {
      return wxUinMatch[1]
    }

    // euin fallback
    const fakeUinMatch = cookie.match(/euin=([A-Za-z0-9_*]+)/)
    if (fakeUinMatch) {
      const realUinMatch = cookie.match(/(?:^|;)\s*uin=(\d+)/)
      if (realUinMatch) {
        return realUinMatch[1]
      }
      // WeChat euin might be usable directly
      return fakeUinMatch[1]
    }

    txLog.warn('无法从Cookie中提取uin')
    return null
  },

  /**
   * Get user info
   */
  async getUserInfo(retryNum = 0): Promise<any> {
    const maxRetries = 3
    const retryDelay = 200
    const cookie = settingState.setting['common.tx_cookie']

    txLog.info('=== getUserInfo 开始 ===')

    if (!cookie) {
      txLog.error('未设置QQ音乐Cookie')
      throw new Error('未设置QQ音乐Cookie')
    }

    try {
      const uin = this.extractUin(cookie)
      if (!uin) {
        throw new Error('Cookie中未找到uin')
      }

      const bodyData = `cid=205360838&userid=${uin}&reqfrom=1`

      const requestObj = httpFetch(`https://${TX_API_HOST}/rsc/fcgi-bin/fcg_get_profile_homepage.fcg`, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://y.qq.com/',
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: bodyData,
      })

      const { body, statusCode } = (await requestObj.promise) as any

      if (statusCode !== 200) {
        throw new Error('获取用户信息失败')
      }

      if (body.code === 1000) {
        throw new Error('QQ音乐Cookie已过期，请重新获取')
      }

      txLog.info('获取用户信息成功')

      return {
        name: body.data?.nick || body.data?.name || 'QQ音乐用户',
        avatar: body.data?.avatarUrl || body.data?.avatar || '',
        uin,
      }
    } catch (error: any) {
      if (retryNum < maxRetries) {
        txLog.warn('获取用户信息失败, 重试次数:', retryNum + 1)
        await new Promise(resolve => setTimeout(resolve, retryDelay))
        return this.getUserInfo(retryNum + 1)
      } else {
        txLog.error('获取用户信息失败 (重试次数已达上限)', error.message)
        throw error
      }
    }
  },

  /**
   * Get user-created playlists
   * Including self-created playlists and "My Favorites" collection
   */
  async getUserPlaylists(retryNum = 0): Promise<any> {
    const maxRetries = 3
    const retryDelay = 200
    const cookie = settingState.setting['common.tx_cookie']

    txLog.info('=== getUserPlaylists 开始 ===')

    if (!cookie) {
      txLog.error('未设置QQ音乐Cookie')
      throw new Error('未设置QQ音乐Cookie')
    }

    try {
      const uin = this.extractUin(cookie)
      if (!uin) {
        throw new Error('Cookie中未找到uin')
      }

      const bodyData = `hostUin=0&hostuin=${uin}&sin=0&size=200&g_tk=5381&loginUin=${uin}&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`

      const requestObj = httpFetch(`https://${TX_API_HOST}/rsc/fcgi-bin/fcg_user_created_diss`, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://y.qq.com/portal/profile.html',
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: bodyData,
      })

      const { body } = (await requestObj.promise) as any

      txLog.debug('自建歌单响应:', JSON.stringify(body).substring(0, 500))

      if (body.code === 1000) {
        throw new Error('QQ音乐Cookie已过期，请重新获取')
      }

      let dissList = body.data?.diss_list || body.data?.disslist

      if (!dissList) {
        if (body.data?.hostname) {
          txLog.warn('获取歌单返回用户主页格式, 用户没有创建歌单')
          dissList = []
        } else {
          throw new Error('获取用户歌单失败')
        }
      }

      txLog.info('获取自建歌单成功, 数量:', dissList.length)

      const excludeDirids = [202, 205, 206]
      const filteredCreatedList = dissList.filter((diss: any) => !excludeDirids.includes(diss.dirid))

      txLog.info('过滤后的自建歌单数量:', filteredCreatedList.length)

      const createdPlaylists = filteredCreatedList.map((diss: any) => {
        let cover = diss.disslogo || diss.diss_cover || diss.cover || ''
        if (diss.dirid === 201) {
          cover = cover && cover !== '?n=1' ? cover : 'https://y.gtimg.cn/mediastyle/yqq/img/icon_favorite.png'
        }
        return {
          id: String(diss.dissid || diss.tid || diss.id),
          tid: diss.dissid || diss.tid || diss.id,
          dirid: diss.dirid,
          name: diss.dissname || diss.diss_name || diss.title || '未知歌单',
          cover,
          songCount: diss.song_cnt || diss.songCount || 0,
          desc: diss.dissdesc || diss.desc || '',
          isFavorites: diss.dirid === 201,
          isCollected: false,
        }
      })

      txLog.info('自建歌单数量:', createdPlaylists.length)

      return createdPlaylists
    } catch (error: any) {
      if (retryNum < maxRetries) {
        txLog.warn('获取用户歌单失败, 重试次数:', retryNum + 1)
        await new Promise(resolve => setTimeout(resolve, retryDelay))
        return this.getUserPlaylists(retryNum + 1)
      } else {
        txLog.error('获取用户歌单失败 (重试次数已达上限)', error.message)
        throw error
      }
    }
  },

  /**
   * Get playlist detail (including song list)
   */
  async getPlaylistDetail(disstid: string, retryNum = 0): Promise<any> {
    const maxRetries = 3
    const retryDelay = 200
    const cookie = settingState.setting['common.tx_cookie']

    txLog.info('=== getPlaylistDetail 开始 === disstid:', disstid)

    if (!cookie) {
      throw new Error('未设置QQ音乐Cookie')
    }

    const fetchPage = async(begin: number, num: number): Promise<any> => {
      const bodyData = `type=1&utf8=1&disstid=${disstid}&loginUin=0&hostUin=0&format=json&inCharset=utf8&song_begin=${begin}&num=${num}`

      const requestObj = httpFetch(`https://${TX_API_HOST}/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg`, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://y.qq.com/n/yqq/playlist',
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: bodyData,
      })

      const { body } = (await requestObj.promise) as any
      txLog.debug('歌单详情响应:', JSON.stringify(body).substring(0, 500))

      if (!body.cdlist?.[0]) {
        throw new Error('获取歌单详情失败')
      }
      return body.cdlist[0]
    }

    try {
      const pageSize = 30
      const firstPage = await fetchPage(0, pageSize)
      const totalSongs = firstPage.songnum ?? firstPage.songlist?.length ?? 0
      const allSongs = [...(firstPage.songlist || [])]

      if (totalSongs > allSongs.length) {
        for (let begin = allSongs.length; begin < totalSongs; begin += pageSize) {
          const page = await fetchPage(begin, pageSize)
          const songs = page.songlist || []
          if (songs.length === 0) break
          allSongs.push(...songs)
        }
      }

      txLog.info('获取歌单详情成功:', {
        name: firstPage.dissname || firstPage.title,
        songCount: allSongs.length,
        total: totalSongs,
      })

      return {
        id: firstPage.dissid || disstid,
        name: firstPage.dissname || firstPage.title || '未知歌单',
        cover: firstPage.logo || firstPage.cover || '',
        desc: firstPage.desc || '',
        creator: {
          name: firstPage.nick || firstPage.creator?.name || '',
          avatar: firstPage.creator?.avatar || '',
        },
        songs: allSongs.map((song: any) => ({
          id: song.songid || song.id,
          name: song.title || song.songname || song.name || '',
          artists: (song.singer || []).map((s: any) => ({
            id: s.id || '',
            name: s.name || '',
          })),
          album: {
            id: song.albumid || song.album?.id || '',
            name: song.albumname || song.album?.name || '',
          },
          strMediaMid: song.strMediaMid || song.media_mid || '',
          songmid: song.songmid || song.mid || '',
          interval: song.interval || 0,
        })),
      }
    } catch (error: any) {
      if (retryNum < maxRetries) {
        txLog.warn('获取歌单详情失败, 重试次数:', retryNum + 1)
        await new Promise(resolve => setTimeout(resolve, retryDelay))
        return this.getPlaylistDetail(disstid, retryNum + 1)
      } else {
        txLog.error('获取歌单详情失败 (重试次数已达上限)', error.message)
        throw error
      }
    }
  },

  /**
   * Add songs to playlist
   * Using new zzc signed API
   */
  async addSongToPlaylist(listId: string, songMids: string[], retryNum = 0): Promise<any> {
    const maxRetries = 3
    const retryDelay = 200
    const cookie = settingState.setting['common.tx_cookie']

    txLog.info('=== addSongToPlaylist 开始 ===', {
      listId,
      songMids,
      songCount: songMids.length,
    })

    if (!cookie) {
      txLog.error('未设置QQ音乐Cookie')
      throw new Error('未设置QQ音乐Cookie，请先在设置中配置QQ Cookie')
    }

    const invalidMids = songMids.filter(mid => !mid)
    if (invalidMids.length > 0) {
      txLog.error('部分歌曲 mid 为空', {
        invalidCount: invalidMids.length,
      })
      throw new Error('部分歌曲 mid 为空')
    }

    try {
      const uin = this.extractUin(cookie)
      if (!uin) {
        txLog.error('Cookie中未找到uin')
        throw new Error('Cookie中未找到uin，请检查Cookie是否正确')
      }

      let dirid = 0
      let tid = parseInt(listId) || 0

      try {
        const playlists = await this.getUserPlaylists()
        const targetPlaylist = playlists.find(
          (p: any) => String(p.id) === String(listId) || String(p.tid) === String(listId),
        )
        if (targetPlaylist) {
          dirid = targetPlaylist.dirid || 0
          tid = targetPlaylist.tid || parseInt(listId) || 0
          txLog.info('找到目标歌单，确定 dirid', {
            name: targetPlaylist.name,
            tid: targetPlaylist.tid,
            id: targetPlaylist.id,
            dirid: targetPlaylist.dirid,
            useDirid: dirid,
          })
        } else {
          txLog.warn('未找到目标歌单，使用默认 dirid=0', { listId })
        }
      } catch (err) {
        txLog.warn('获取歌单列表失败，使用默认 dirid=0', err)
      }

      const songInfo: Array<{ songId: number, songType: number }> = []
      const failedMids: string[] = []

      for (const mid of songMids) {
        try {
          if (/^\d+$/.test(mid.trim())) {
            const parsedId = parseInt(mid)
            songInfo.push({ songId: parsedId, songType: 13 })
          } else {
            const musicInfo = await getMusicInfo(mid)
            if (musicInfo?.songId) {
              songInfo.push({ songId: musicInfo.songId, songType: 13 })
              txLog.info('从 mid 获取到 songId', { mid, songId: musicInfo.songId, name: musicInfo.name })
            } else {
              txLog.warn('getMusicInfo 返回空，尝试备用方法', { mid })
              try {
                const searchResult = await this.searchSong(mid)
                if (searchResult && searchResult.length > 0) {
                  const foundSong = searchResult[0]
                  if (foundSong.songId) {
                    songInfo.push({ songId: foundSong.songId, songType: 13 })
                    txLog.info('通过搜索获取到 songId', { mid, songId: foundSong.songId, name: foundSong.name })
                  } else {
                    txLog.error('搜索结果中没有 songId', { mid })
                    failedMids.push(mid)
                  }
                } else {
                  txLog.error('无法获取歌曲 songId', { mid })
                  errorLog.error(`[QQ音乐] 无法获取歌曲 songId: ${mid}`)
                  failedMids.push(mid)
                }
              } catch (searchErr: any) {
                txLog.error('搜索歌曲失败', { mid, error: searchErr.message })
                failedMids.push(mid)
              }
            }
          }
        } catch (err: any) {
          txLog.error('获取歌曲详情失败', { mid, error: err.message })
          errorLog.error(`[QQ音乐] 获取歌曲详情失败: ${mid}, 错误: ${err.message}`)
          failedMids.push(mid)
        }
      }

      if (songInfo.length === 0) {
        txLog.error('没有有效的歌曲可以添加', { failedMids })
        errorLog.error('[QQ音乐] 没有有效的歌曲可以添加')
        throw new Error('没有有效的歌曲可以添加')
      }

      if (failedMids.length > 0) {
        txLog.warn('部分歌曲获取 songId 失败', { failedMids, successCount: songInfo.length })
      }

      const payload = {
        comm: {
          ct: 24,
          cv: 1800,
        },
        req_0: {
          module: 'music.musicasset.PlaylistDetailWrite',
          method: 'AddSonglist',
          param: {
            dirId: dirid,
            tid,
            bFmtUtf8: true,
            v_songInfo: songInfo,
          },
        },
      }

      const sign = await zzcSign(JSON.stringify(payload))

      txLog.info('请求参数', {
        uin,
        listId,
        dirid,
        tid,
        songCount: songMids.length,
        apiUrl: TX_MUSIC_U_FCG,
        signLength: sign.length,
      })

      const requestObj = httpFetch(
        `${TX_MUSIC_U_FCG}?sign=${sign}`,
        {
          method: 'POST',
          headers: {
            'User-Agent': 'QQMusic 14090508(android 12)',
            Referer: 'https://y.qq.com/',
            Cookie: cookie,
          },
          body: payload,
        },
      )

      const { body, statusCode } = (await requestObj.promise) as any

      txLog.info('API响应', {
        statusCode,
        code: body?.code,
        retCode: body?.req_0?.data?.retCode,
        response: JSON.stringify(body).substring(0, 500),
      })

      if (statusCode !== 200) {
        txLog.error('HTTP请求失败', { statusCode })
        errorLog.error(`[QQ音乐] HTTP请求失败，状态码: ${statusCode}`)
        throw new Error(`HTTP请求失败，状态码: ${statusCode}`)
      }

      const retCode = body?.req_0?.data?.retCode
      const reqCode = body?.req_0?.code
      if (body?.code != null && body.code !== 0) {
        throw new Error(`添加歌曲失败，错误码: ${body.code}`)
      }
      if (retCode === 1000 || retCode === 1001) {
        txLog.error('未登录或登录已过期')
        errorLog.error('[QQ音乐] 未登录或登录已过期，请更新QQ Cookie')
        throw new Error('QQ音乐登录已过期，请重新登录QQ音乐')
      }

      if (retCode != null && retCode !== 0) {
        const errorMsg = body?.req_0?.data?.retMsg || `添加歌曲失败，错误码: ${retCode}`
        txLog.error('添加歌曲失败', {
          retCode,
          msg: body?.req_0?.data?.retMsg,
          dirid,
          listId,
          songMids,
        })
        errorLog.error(`[QQ音乐] 添加歌曲失败: ${errorMsg}, 歌单ID: ${listId}, 歌曲数量: ${songMids.length}`)
        throw new Error(errorMsg)
      }

      // retCode 缺失时不再当成失败：部分写接口只在 req_0.code 上回业务码。
      if (retCode == null && reqCode != null && reqCode !== 0) {
        const errorMsg = body?.req_0?.data?.retMsg || `添加歌曲失败，模块错误码: ${reqCode}`
        errorLog.error(`[QQ音乐] 添加歌曲失败: ${errorMsg}, 歌单ID: ${listId}, 歌曲数量: ${songMids.length}`)
        throw new Error(errorMsg)
      }

      txLog.info('添加歌曲成功', {
        dirid,
        songCount: songMids.length,
      })
      errorLog.info(`[QQ音乐] 添加歌曲成功，歌单ID: ${listId}, 歌曲数量: ${songMids.length}`)

      return {
        success: true,
        message: '添加成功',
      }
    } catch (error: any) {
      txLog.error('添加歌曲异常', {
        error: error.message,
        stack: error.stack,
        listId,
        songMids,
        retryNum,
      })
      errorLog.error(`[QQ音乐] 添加歌曲异常: ${error.message}, 歌单ID: ${listId}`)

      if (retryNum < maxRetries) {
        txLog.warn('添加歌曲失败, 重试次数:', retryNum + 1)
        await new Promise(resolve => setTimeout(resolve, retryDelay))
        return this.addSongToPlaylist(listId, songMids, retryNum + 1)
      } else {
        txLog.error('添加歌曲失败 (重试次数已达上限)', error.message)
        errorLog.error(`[QQ音乐] 添加歌曲失败 (重试次数已达上限): ${error.message}`)
        throw error
      }
    }
  },

  /**
   * Get "My Favorites" collected music
   */
  async getFavoritesMusic(page = 1, pageSize = 30, retryNum = 0): Promise<any> {
    const maxRetries = 3
    const retryDelay = 200
    const cookie = settingState.setting['common.tx_cookie']

    txLog.info('=== getFavoritesMusic 开始 === page:', page)

    if (!cookie) {
      txLog.error('未设置QQ音乐Cookie')
      throw new Error('未设置QQ音乐Cookie')
    }

    try {
      const uin = this.extractUin(cookie)
      if (!uin) {
        throw new Error('Cookie中未找到uin')
      }

      const playlists = await this.getUserPlaylists()
      const favoritesPlaylist = playlists.find((p: any) => p.isFavorites)

      if (!favoritesPlaylist) {
        txLog.warn('未找到"我喜欢"歌单')
        return {
          list: [],
          total: 0,
          page,
          pageSize,
          hasMore: false,
        }
      }

      const detail = await this.getPlaylistDetail(favoritesPlaylist.id)

      const startIndex = (page - 1) * pageSize
      const endIndex = startIndex + pageSize
      const pagedList = detail.songs.slice(startIndex, endIndex)

      return {
        list: pagedList,
        total: detail.songs.length,
        page,
        pageSize,
        hasMore: endIndex < detail.songs.length,
      }
    } catch (error: any) {
      if (retryNum < maxRetries) {
        txLog.warn('获取收藏音乐失败, 重试次数:', retryNum + 1)
        await new Promise(resolve => setTimeout(resolve, retryDelay))
        return this.getFavoritesMusic(page, pageSize, retryNum + 1)
      } else {
        txLog.error('获取收藏音乐失败 (重试次数已达上限)', error.message)
        throw error
      }
    }
  },

  /**
   * Extract euin (encrypted UIN) from Cookie
   */
  extractEuin(cookie: string): string | null {
    if (!cookie) return null
    const euinMatch = cookie.match(/euin=([^;]+)/)
    return euinMatch ? euinMatch[1] : null
  },

  /** 写接口 comm.authst 需要的登录票据（qm_keyst / qqmusic_key） */
  extractMusicKey(cookie: string): string {
    if (!cookie) return ''
    const match = cookie.match(/(?:^|;\s*)(?:qm_keyst|qqmusic_key)=([^;]+)/)
    return match ? match[1] : ''
  },

  /** 微信登录的 comm.tmeLoginType（QQ 登录可缺省） */
  extractLoginType(cookie: string): number | undefined {
    if (!cookie) return undefined
    const match = cookie.match(/(?:^|;\s*)(?:login_type|tmeLoginType)=(\d+)/)
    return match ? Number(match[1]) : undefined
  },

  /**
   * Send signed request
   */
  async sendSignedRequest(payload: any): Promise<any> {
    const cookie = settingState.setting['common.tx_cookie']
    const sign = await zzcSign(JSON.stringify(payload))

    const requestObj = httpFetch(
      `${TX_MUSIC_U_FCG}?sign=${sign}`,
      {
        method: 'POST',
        headers: {
          'User-Agent': 'QQMusic 14090508(android 12)',
          Referer: 'https://y.qq.com/',
          Cookie: cookie,
        },
        body: payload,
      },
    )

    const { body, statusCode } = (await requestObj.promise) as any

    if (statusCode !== 200) {
      throw new Error(`HTTP请求失败，状态码: ${statusCode}`)
    }

    if (body.code === 1000) {
      throw new Error('QQ音乐Cookie已过期，请重新获取')
    }

    return body
  },

  /**
   * Get user-created playlists (using new API)
   */
  async getCreatedPlaylists(retryNum = 0): Promise<any> {
    const maxRetries = 3
    const retryDelay = 200
    const cookie = settingState.setting['common.tx_cookie']

    txLog.info('=== getCreatedPlaylists 开始 ===')

    if (!cookie) {
      throw new Error('未设置QQ音乐Cookie')
    }

    try {
      const uin = this.extractUin(cookie)
      if (!uin) {
        throw new Error('Cookie中未找到uin')
      }

      const payload = {
        comm: { ct: 24, cv: 1800 },
        req_0: {
          module: 'music.musicasset.PlaylistBaseRead',
          method: 'GetPlaylistByUin',
          param: { uin: String(uin) },
        },
      }

      const body = await this.sendSignedRequest(payload)

      if (body.code !== 0 || body.req_0?.code !== 0) {
        throw new Error('获取用户自建歌单失败')
      }

      const playlists = body.req_0?.data?.v_playlist || []

      txLog.info('获取用户自建歌单成功', { count: playlists.length })

      const excludeDirids = [202, 205, 206]
      const filteredPlaylists = playlists.filter((p: any) => !excludeDirids.includes(p.dirId))

      return filteredPlaylists.map((p: any) => ({
        id: String(p.tid),
        tid: p.tid,
        dirid: p.dirId,
        name: p.dirName,
        cover: p.picUrl || p.bigpicUrl || '',
        songCount: p.songNum || 0,
        desc: p.desc || '',
        isFavorites: p.dirId === 201,
        isCollected: false,
        createTime: p.createTime,
        updateTime: p.updateTime,
      }))
    } catch (error: any) {
      if (retryNum < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay))
        return this.getCreatedPlaylists(retryNum + 1)
      }
      throw error
    }
  },

  /**
   * Get user's favorited songs (My Favorites)
   */
  async getFavSongs(page = 1, pageSize = 30, retryNum = 0): Promise<any> {
    const maxRetries = 3
    const retryDelay = 200
    const cookie = settingState.setting['common.tx_cookie']

    txLog.info('=== getFavSongs 开始 ===', { page, pageSize })

    if (!cookie) {
      throw new Error('未设置QQ音乐Cookie')
    }

    try {
      const euin = this.extractEuin(cookie)
      if (!euin) {
        throw new Error('Cookie中未找到euin')
      }

      const payload = {
        comm: { ct: 24, cv: 1800 },
        req_0: {
          module: 'music.srfDissInfo.DissInfo',
          method: 'CgiGetDiss',
          param: {
            disstid: 0,
            dirid: 201,
            tag: true,
            song_begin: (page - 1) * pageSize,
            song_num: pageSize,
            userinfo: true,
            orderlist: true,
            enc_host_uin: euin,
          },
        },
      }

      const body = await this.sendSignedRequest(payload)

      if (body.code !== 0 || body.req_0?.code !== 0) {
        throw new Error('获取收藏歌曲失败')
      }

      const data = body.req_0?.data || {}
      const songs = data.songlist || []
      const total = data.dirinfo?.songnum || 0

      txLog.info('获取收藏歌曲成功', { count: songs.length, total })

      return {
        list: songs.map((song: any) => ({
          id: song.id,
          mid: String(song.id),
          songmid: song.songmid || song.mid,
          name: song.title || song.name,
          singer: (song.singer || []).map((s: any) => s.name).join('/'),
          albumName: song.album?.name || '',
          albumMid: song.album?.mid || '',
          interval: song.interval || 0,
          source: 'tx',
        })),
        total,
        page,
        pageSize,
        hasMore: (page * pageSize) < total,
        dirInfo: {
          id: data.dirinfo?.id,
          name: data.dirinfo?.title,
          songCount: data.dirinfo?.songnum,
        },
      }
    } catch (error: any) {
      if (retryNum < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay))
        return this.getFavSongs(page, pageSize, retryNum + 1)
      }
      throw error
    }
  },

  /**
   * Get user's collected playlists
   */
  async getFavPlaylists(page = 1, pageSize = 30, retryNum = 0): Promise<any> {
    const maxRetries = 3
    const retryDelay = 200
    const cookie = settingState.setting['common.tx_cookie']

    txLog.info('=== getFavPlaylists 开始 ===', { page, pageSize })

    if (!cookie) {
      throw new Error('未设置QQ音乐Cookie')
    }

    try {
      const euin = this.extractEuin(cookie)
      if (!euin) {
        throw new Error('Cookie中未找到euin')
      }

      const payload = {
        comm: { ct: 24, cv: 1800 },
        req_0: {
          module: 'music.musicasset.PlaylistFavRead',
          method: 'CgiGetPlaylistFavInfo',
          param: {
            uin: euin,
            offset: (page - 1) * pageSize,
            size: pageSize,
          },
        },
      }

      const body = await this.sendSignedRequest(payload)

      if (body.code !== 0 || body.req_0?.code !== 0) {
        throw new Error('获取收藏歌单失败')
      }

      const data = body.req_0?.data || {}
      const playlists = data.v_list || []
      const total = data.total || data.number || 0

      txLog.info('获取收藏歌单成功', { count: playlists.length, total })

      return {
        list: playlists.map((p: any) => ({
          id: String(p.tid),
          tid: p.tid,
          dirid: p.dirId,
          name: p.name,
          cover: p.logo || p.albumPicUrl || '',
          songCount: p.songnum || 0,
          desc: '',
          isFavorites: false,
          isCollected: true,
          nickname: p.nickname || '',
          createTime: p.createtime,
          updateTime: p.updateTime,
        })),
        total,
        page,
        pageSize,
        hasMore: data.hasmore === 1,
      }
    } catch (error: any) {
      if (retryNum < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay))
        return this.getFavPlaylists(page, pageSize, retryNum + 1)
      }
      throw error
    }
  },

  /**
   * Remove songs from playlist
   * @param listId Playlist ID
   * @param songMids Song mid list
   */
  async removeSongFromPlaylist(listId: string, songMids: string[], retryNum = 0): Promise<any> {
    const maxRetries = 3
    const retryDelay = 200
    const cookie = settingState.setting['common.tx_cookie']

    txLog.info('=== removeSongFromPlaylist 开始 ===', { listId, songMids, songCount: songMids.length })

    if (!cookie) {
      throw new Error('未设置QQ音乐Cookie')
    }

    try {
      const uin = this.extractUin(cookie)
      if (!uin) {
        throw new Error('Cookie中未找到uin')
      }

      let dirid = 0
      let tid = parseInt(listId) || 0

      try {
        const playlists = await this.getUserPlaylists()
        const targetPlaylist = playlists.find(
          (p: any) => String(p.id) === String(listId) || String(p.tid) === String(listId),
        )
        if (targetPlaylist) {
          dirid = targetPlaylist.dirid || 0
          tid = targetPlaylist.tid || parseInt(listId) || 0
          txLog.info('找到目标歌单', { name: targetPlaylist.name, dirid, tid })
        }
      } catch (err) {
        txLog.warn('获取歌单列表失败，使用默认 dirid=0', err)
      }

      const songInfo: Array<{ songId: number, songType: number }> = []
      const failedMids: string[] = []

      for (const mid of songMids) {
        try {
          if (/^\d+$/.test(mid.trim())) {
            const parsedId = parseInt(mid)
            songInfo.push({ songId: parsedId, songType: 13 })
          } else {
            const musicInfo = await getMusicInfo(mid)
            if (musicInfo?.songId) {
              songInfo.push({ songId: musicInfo.songId, songType: 13 })
            } else {
              try {
                const searchResult = await this.searchSong(mid)
                if (searchResult && searchResult.length > 0 && searchResult[0].songId) {
                  songInfo.push({ songId: searchResult[0].songId, songType: 13 })
                } else {
                  failedMids.push(mid)
                }
              } catch {
                failedMids.push(mid)
              }
            }
          }
        } catch (err: any) {
          txLog.error('获取歌曲详情失败', { mid, error: err.message })
          failedMids.push(mid)
        }
      }

      if (songInfo.length === 0) {
        throw new Error('没有有效的歌曲可以删除')
      }

      const payload = {
        comm: { ct: 24, cv: 1800 },
        req_0: {
          module: 'music.musicasset.PlaylistDetailWrite',
          method: 'DelSonglist',
          param: {
            dirId: dirid,
            tid,
            bFmtUtf8: true,
            v_songInfo: songInfo,
          },
        },
      }

      const body = await this.sendSignedRequest(payload)

      const retCode = body?.req_0?.data?.retCode
      const reqCode = body?.req_0?.code
      if (body?.code != null && body.code !== 0) {
        throw new Error(`删除歌曲失败，错误码: ${body.code}`)
      }
      if (retCode === 1000 || retCode === 1001) {
        throw new Error('QQ音乐登录已过期，请重新登录QQ音乐')
      }
      if (retCode != null && retCode !== 0) {
        throw new Error(body?.req_0?.data?.retMsg || `删除歌曲失败，错误码: ${retCode}`)
      }
      if (retCode == null && reqCode != null && reqCode !== 0) {
        throw new Error(body?.req_0?.data?.retMsg || `删除歌曲失败，模块错误码: ${reqCode}`)
      }

      txLog.info('删除歌曲成功', { dirid, tid, songCount: songInfo.length })
      errorLog.info(`[QQ音乐] 删除歌曲成功，歌单ID: ${listId}, 歌曲数量: ${songInfo.length}`)

      return {
        success: true,
        message: '删除成功',
        removedCount: songInfo.length,
        failedCount: failedMids.length,
      }
    } catch (error: any) {
      txLog.error('删除歌曲失败', { error: error.message, listId, songMids })
      errorLog.error(`[QQ音乐] 删除歌曲失败: ${error.message}, 歌单ID: ${listId}`)

      if (retryNum < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay))
        return this.removeSongFromPlaylist(listId, songMids, retryNum + 1)
      }
      throw error
    }
  },

  /**
   * Delete playlist
   */
  async deletePlaylist(dirid: number, retryNum = 0): Promise<any> {
    const maxRetries = 3
    const retryDelay = 200
    const cookie = settingState.setting['common.tx_cookie']

    txLog.info('=== deletePlaylist 开始 ===', { dirid })

    if (!cookie) {
      throw new Error('未设置QQ音乐Cookie')
    }

    if (dirid === 201) {
      throw new Error('不能删除"我喜欢"歌单')
    }

    try {
      const payload = {
        comm: { ct: 24, cv: 1800 },
        req_0: {
          module: 'music.musicasset.PlaylistBaseWrite',
          method: 'DelPlaylist',
          param: { dirId: dirid },
        },
      }

      const body = await this.sendSignedRequest(payload)

      const retCode = body?.req_0?.data?.retCode
      if (retCode === 1000 || retCode === 1001) {
        throw new Error('QQ音乐登录已过期，请重新登录QQ音乐')
      }
      if (retCode !== 0) {
        const retMsg = body?.req_0?.data?.retMsg
        if (retCode === undefined || retCode === null) {
          throw new Error('删除歌单失败，Cookie无效或已过期，请重新登录QQ音乐')
        }
        throw new Error(`${retMsg || `删除歌单失败，错误码: ${retCode}`}，可能是Cookie已失效，请重新登录QQ音乐`)
      }

      txLog.info('删除歌单成功', { dirid })
      errorLog.info(`[QQ音乐] 删除歌单成功，dirid: ${dirid}`)

      return {
        success: true,
        message: '删除成功',
        dirid: body?.req_0?.data?.dirid,
      }
    } catch (error: any) {
      txLog.error('删除歌单失败', { error: error.message, dirid })
      errorLog.error(`[QQ音乐] 删除歌单失败: ${error.message}, dirid: ${dirid}`)

      if (retryNum < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay))
        return this.deletePlaylist(dirid, retryNum + 1)
      }
      throw error
    }
  },

  /**
   * Create playlist
   * @param name Playlist name
   */
  async createPlaylist(name: string, retryNum = 0): Promise<any> {
    const maxRetries = 3
    const retryDelay = 200
    const cookie = settingState.setting['common.tx_cookie']

    txLog.info('=== createPlaylist 开始 ===', { name })

    if (!cookie) {
      throw new Error('未设置QQ音乐Cookie')
    }

    try {
      const payload = {
        comm: { ct: 24, cv: 1800 },
        req_0: {
          module: 'music.musicasset.PlaylistBaseWrite',
          method: 'AddPlaylist',
          param: { dirName: name },
        },
      }

      const body = await this.sendSignedRequest(payload)

      const retCode = body?.req_0?.data?.retCode
      if (retCode === 1000 || retCode === 1001) {
        throw new Error('QQ音乐登录已过期，请重新登录QQ音乐')
      }
      if (retCode !== 0) {
        throw new Error(`${body?.req_0?.data?.retMsg || `创建歌单失败，错误码: ${retCode}`}，可能是Cookie已失效，请重新登录QQ音乐`)
      }

      const newDirid = body?.req_0?.data?.dirid
      txLog.info('创建歌单成功', { name, dirid: newDirid })
      errorLog.info(`[QQ音乐] 创建歌单成功: ${name}, dirid: ${newDirid}`)

      return {
        success: true,
        message: '创建成功',
        dirid: newDirid,
        name,
      }
    } catch (error: any) {
      txLog.error('创建歌单失败', { error: error.message, name })
      errorLog.error(`[QQ音乐] 创建歌单失败: ${error.message}`)

      if (retryNum < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay))
        return this.createPlaylist(name, retryNum + 1)
      }
      throw error
    }
  },

  /**
   * Get "My Favorites" playlist ID
   */
  async getLikedListId(): Promise<string | null> {
    try {
      const playlists = await this.getUserPlaylists()
      const likedList = playlists.find((p: any) => p.dirid === 201 || p.isFavorites)
      return likedList ? String(likedList.id || likedList.tid) : null
    } catch (error: any) {
      txLog.error('获取"我喜欢"歌单ID失败', { error: error.message })
      return null
    }
  },

  /**
   * Get song detail by songmid
   * Fallback method when getMusicInfo fails
   */
  async searchSong(songmid: string): Promise<any[]> {
    txLog.info('=== searchSong 开始 ===', { songmid })

    try {
      const payload = {
        comm: { ct: 24, cv: 1800 },
        req: {
          module: 'music.pf_song_detail_svr',
          method: 'get_song_detail_yqq',
          param: {
            song_type: 0,
            song_mid: songmid,
          },
        },
      }

      txLog.info('searchSong: 请求payload', { payload: JSON.stringify(payload) })
      const body = await this.sendSignedRequest(payload)

      txLog.info('searchSong: 原始响应', { body: JSON.stringify(body) })

      if (!body || body.code !== 0) {
        txLog.warn('searchSong: 获取歌曲详情失败', { songmid, code: body?.code })
        return []
      }

      const trackInfo = body.req?.data?.track_info
      if (!trackInfo) {
        txLog.warn('searchSong: 未找到歌曲信息', { songmid })
        return []
      }

      const songId = trackInfo.id
      if (!songId || songId === 0) {
        txLog.warn('searchSong: songId 无效', { songmid, songId })
        return []
      }

      txLog.info('searchSong: 获取成功', { songmid, songId, name: trackInfo.title })

      return [{
        songId,
        songmid: trackInfo.mid,
        name: trackInfo.title,
        singer: (trackInfo.singer || []).map((s: any) => s.name).join('/'),
      }]
    } catch (error: any) {
      txLog.error('searchSong 失败', { songmid, error: error.message })
      return []
    }
  },

  /**
   * 把一组歌曲标识（数字 songId 或 mid）解析成写接口需要的数字 songId。
   * QQ 的 AddSonglist/DelSonglist 只认数字 songId：mid 必须先走 getMusicInfo，
   * 取不到时再用歌曲详情搜索兜底。
   */
  async resolveSongInfo(songIds: string[]): Promise<{
    songInfo: Array<{ songId: number, songType: number }>
    failedIds: string[]
  }> {
    const songInfo: Array<{ songId: number, songType: number }> = []
    const failedIds: string[] = []
    for (const raw of songIds) {
      const id = String(raw ?? '').trim()
      if (!id) {
        failedIds.push(id)
        continue
      }
      if (/^\d+$/.test(id)) {
        // 普通歌曲的 songType 是 0（官网红心写入的实测值；13 是旧猜法）。
        songInfo.push({ songId: parseInt(id, 10), songType: 0 })
        continue
      }
      try {
        const musicInfo = await getMusicInfo(id)
        if (musicInfo?.songId) {
          songInfo.push({ songId: musicInfo.songId, songType: 0 })
          continue
        }
        const searchResult = await this.searchSong(id)
        const songId = searchResult?.[0]?.songId
        if (songId) {
          songInfo.push({ songId, songType: 0 })
        } else {
          failedIds.push(id)
        }
      } catch (err: any) {
        txLog.warn('解析歌曲数字 songId 失败', { id, error: err?.message })
        failedIds.push(id)
      }
    }
    return { songInfo, failedIds }
  },

  /**
   * 「我喜欢」目录 id：PlaylistDetailWrite 必须使用 PlaylistBaseRead 返回的 dirId。
   * 老接口的 tid / 固定 201 都可能不是当前账号实际入口（迁移过的账号会变）。
   */
  async getFavoritePlaylistDirId(cookie: string, uin: string, musicKey: string): Promise<number> {
    const fallback = 201
    try {
      const gTk = qqHash33(musicKey)
      const payload = {
        comm: {
          ct: 24,
          cv: 4747474,
          platform: 'yqq.json',
          uin,
          qq: uin,
          authst: musicKey,
          tmeLoginType: this.extractLoginType(cookie),
          g_tk: gTk,
          g_tk_new_20200303: gTk,
          format: 'json',
        },
        req_0: {
          module: 'music.musicasset.PlaylistBaseRead',
          method: 'GetPlaylistByUin',
          param: { uin, bWithoutStatus: false },
        },
      }
      const { body } = await httpFetch(TX_MUSIC_U, {
        method: 'post',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://y.qq.com/',
          Cookie: cookie,
        },
        body: payload,
      }).promise as any
      const playlists = body?.req_0?.data?.v_playlist
      if (Array.isArray(playlists)) {
        const favorite = playlists.find((item: any) => {
          const dirId = Number(item?.dirId ?? item?.dirid)
          const name = String(item?.dirName ?? item?.dir_name ?? item?.title ?? item?.name ?? '').trim()
          return dirId === 201 || name === '我喜欢' || name === '我喜欢的音乐'
        })
        const dirId = Number(favorite?.dirId ?? favorite?.dirid)
        if (Number.isFinite(dirId) && dirId > 0) return dirId
      }
    } catch (err: any) {
      txLog.warn('解析「我喜欢」目录失败，回退 201', { error: err?.message })
    }
    return fallback
  },

  /**
   * Like/unlike a song
   * @param songMid Song mid or numeric songId
   * @param like true=like, false=unlike
   */
  async likeSong(songMid: string, like: boolean): Promise<boolean> {
    const cookie = settingState.setting['common.tx_cookie']
    if (!cookie) throw new Error('未设置QQ音乐Cookie')

    // 写接口的 uin 必须是纯数字：QQ 登录用 uin，微信登录用 wxuin。
    const uinMatch = cookie.match(/(?:^|;\s*)uin=(\d+)/) ||
      cookie.match(/(?:^|;\s*)(?:wxUin|wxuin)=(\d+)/)
    const uin = uinMatch ? uinMatch[1] : (this.extractUin(cookie) ?? '').replace(/\D/g, '')
    const musicKey = this.extractMusicKey(cookie)
    if (!uin) throw new Error('Cookie中未找到可用的 uin，请重新登录QQ音乐')
    if (!musicKey) throw new Error('Cookie中缺少 qm_keyst/qqmusic_key，请重新登录QQ音乐')

    const { songInfo, failedIds } = await this.resolveSongInfo([songMid])
    if (!songInfo.length) {
      throw new Error(like ? '无法获取该歌曲的数字 songId，未加入我喜欢' : '无法获取该歌曲的数字 songId，未从我喜欢移除')
    }

    // 「我喜欢」目录 id 不能写死：先解析当前账号实际入口的 dirId，失败退回 201。
    const favoriteDirId = await this.getFavoritePlaylistDirId(cookie, uin, musicKey)

    const gTk = qqHash33(musicKey)
    const payload = {
      comm: {
        ct: 24,
        cv: 4747474,
        platform: 'yqq.json',
        uin,
        qq: uin,
        authst: musicKey,
        tmeLoginType: this.extractLoginType(cookie),
        g_tk: gTk,
        g_tk_new_20200303: gTk,
        format: 'json',
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        notice: 0,
        need_new_code: 1,
      },
      req_0: {
        module: 'music.musicasset.PlaylistDetailWrite',
        method: like ? 'AddSonglist' : 'DelSonglist',
        param: {
          dirId: favoriteDirId,
          v_songInfo: songInfo,
        },
      },
    }

    // 官方写接口启用了 needSign：请求体必须 ag-1 加密，纯签名+明文会回 80105
    // （业务块非 0、内层 retCode 却仍可能是 0，只看 retCode 会误报成功）。
    const requestBody = JSON.stringify(payload)
    const encryptedBody = encodeAG1Request(requestBody)
    const sign = await zzcSignV2(requestBody)
    const url = `${TX_MUSIC_U_FCG_AG1}?_=${Date.now()}&encoding=ag-1&sign=${encodeURIComponent(sign)}`

    const requestObj = httpFetch(url, {
      method: 'post',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://y.qq.com/',
        'Content-Type': 'text/plain',
        Cookie: cookie,
      },
      body: encryptedBody,
      binary: true,
      timeout: 15000,
    })
    const { body, statusCode } = await requestObj.promise as any
    if (statusCode !== 200) throw new Error(`HTTP请求失败，状态码: ${statusCode}`)

    let responseData: any
    try {
      responseData = JSON.parse(decodeAG1Response(body))
    } catch (err: any) {
      throw new Error(`QQ音乐写入响应解密失败：${err?.message || err}`)
    }

    const req = responseData?.req_0 || responseData
    const reqCode = req?.code
    const retCode = req?.data?.retCode
    const msg = req?.msg || req?.errMsg || req?.data?.msg || req?.data?.retMsg || ''
    txLog.info('喜欢接口响应(ag-1)', {
      like,
      dirId: favoriteDirId,
      code: responseData?.code,
      reqCode,
      retCode,
      msg,
    })

    if (reqCode != null && Number(reqCode) !== 0) {
      throw new Error(`${like ? '加入' : '移出'}我喜欢失败${msg ? `：${msg}` : ''}（代码 ${reqCode}）`)
    }
    if (retCode != null && Number(retCode) !== 0) {
      throw new Error(`${like ? '加入' : '移出'}我喜欢失败${msg ? `：${msg}` : ''}（retCode ${retCode}）`)
    }
    if (reqCode == null && retCode == null && Number(responseData?.code) !== 0) {
      throw new Error(`${like ? '加入' : '移出'}我喜欢失败（代码 ${responseData?.code}）`)
    }

    txLog.info(like ? '喜欢歌曲成功' : '取消喜欢歌曲成功', {
      songMid,
      songId: songInfo[0]?.songId,
      dirId: favoriteDirId,
      failedCount: failedIds.length,
    })
    return true
  },
}
