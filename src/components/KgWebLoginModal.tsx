import { forwardRef, useImperativeHandle, useRef, useCallback, useState, useEffect } from 'react'
import { View, StyleSheet, TouchableOpacity, TextInput, ScrollView, Modal as RNModal } from 'react-native'
import WebView from 'react-native-webview'
import Modal, { type ModalType } from '@/components/common/Modal'
import { useTheme } from '@/store/theme/hook'
import { useStatusbarHeight } from '@/store/common/hook'
import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import { toast } from '@/utils/tools'
import { useButtonRadius } from '@/utils/buttonRadius'
import { sendCaptcha, loginByPhone, buildCookieString, getVerifyInfo, verifyUserInfo } from '@/utils/musicSdk/kg/utils/api'

export interface KgWebLoginModalType { show: () => void }

function generateVerifyHtml(txappid: string, ssaCode: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>*{margin:0;padding:0}body{background:transparent}</style></head><body><script>
var appid='${txappid}';var code='${ssaCode}';
var s=document.createElement('script');s.src='https://turing.captcha.qcloud.com/TCaptcha.js';
s.onload=function(){var c=new TencentCaptcha(appid,function(r){
if(r.ret===0){window.ReactNativeWebView.postMessage(JSON.stringify({type:'ok',ticket:r.ticket,randstr:r.randstr,appid:appid,code:code}));}
else{window.ReactNativeWebView.postMessage(JSON.stringify({type:'captcha_fail',ret:r.ret,desc:r.desc}));}
},{type:'popup',enableDarkMode:false,themeColor:'#1677ff'});c.show();};
s.onerror=function(e){window.ReactNativeWebView.postMessage(JSON.stringify({type:'error',msg:String(e)}));};
document.head.appendChild(s);</script></body></html>`
}

// 登录页是本工程里少数「整页自绘」的界面：整页底色 + 按钮主色都按酷狗官方登录页
// 固定，**不跟随全局「按钮透明度」**。此前这里写的是
// `applyOpacity('#1677ff', buttonOpacity)`，用户把按钮透明度调到 0 后：
//   · 登录按钮 → 底色透明 + 白字，压在本页 #ffffff 底上 = 完全看不见；
//   · 登录后「多账号选择」弹窗的确定登录 → 同上；
//   · 同弹窗的「取消」借的是 theme['c-border'] 当底色配白字，浅色主题下本来就是
//     白底白字，跟按钮透明度无关也看不见。
// （用户第 11 轮第 3 条）。现在这四处色值全部写死，任何按钮透明度下都保持可见；
// 加载/禁用态另给一个浅蓝，避免用 c-border 时又撞成「底与字同色」。
const KG_BRAND = '#1677ff'
const KG_BRAND_BUSY = '#9dc3f7'
const KG_NEUTRAL_BG = '#f2f2f2'
const KG_NEUTRAL_FG = '#666666'

const KgWebLoginModal = forwardRef<KgWebLoginModalType, object>((_, ref) => {
  const modalRef = useRef<ModalType>(null)
  const theme = useTheme()
  const buttonRadius = useButtonRadius()
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [cooldown, setCooldown] = useState(0)
  const [logging, setLogging] = useState(false)
  const [showVerify, setShowVerify] = useState(false)
  const [verifyHtml, setVerifyHtml] = useState('')
  const [showMultiAccount, setShowMultiAccount] = useState(false)
  // 原生 Modal 延迟卸载（见下方 RNModal 处注释）
  const [multiAccountMounted, setMultiAccountMounted] = useState(false)
  useEffect(() => {
    if (showMultiAccount) {
      setMultiAccountMounted(true)
      return
    }
    const timer = setTimeout(() => { setMultiAccountMounted(false) }, 300)
    return () => { clearTimeout(timer) }
  }, [showMultiAccount])
  const [pendingData, setPendingData] = useState<{ mobile: string, code: string } | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cdRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sendRef = useRef<() => void>(() => {})

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); if (cdRef.current) clearInterval(cdRef.current) }, [])

  const handleClose = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    if (cdRef.current) { clearInterval(cdRef.current); cdRef.current = null }
    setShowVerify(false); setShowMultiAccount(false); setPendingData(null); setSelectedId('')
    modalRef.current?.setVisible(false)
  }, [])

  useImperativeHandle(ref, () => ({
    show() { setPhone(''); setCode(''); setSending(false); setCountdown(0); setCooldown(0); setLogging(false); setShowVerify(false); setShowMultiAccount(false); setPendingData(null); setSelectedId(''); modalRef.current?.setVisible(true) },
  }))

  const handleVerifyMsg = useCallback(async(e: any) => {
    try {
      const d = JSON.parse(e.nativeEvent.data)
      console.log('[KgLogin] 滑块验证回调:', JSON.stringify(d))
      console.log('[KgLogin] 滑块回调原始数据:', JSON.stringify(d))
      if (d.type === 'ok') {
        const vcode = 'KGCodeTX|' + JSON.stringify({ ticket: d.ticket, randstr: d.randstr, txappid: d.appid })
        console.log('[KgLogin] 提交验证结果...')
        const r = await verifyUserInfo(d.code, 23, vcode, '', '')
        console.log('[KgLogin] verifyUserInfo result:', JSON.stringify(r))
        setShowVerify(false)
        if (r.success) { toast('验证通过'); setTimeout(() => { sendRef.current?.() }, 500) } else toast('验证失败')
      } else if (d.type === 'error') {
        console.log('[KgLogin] 脚本加载失败:', d.msg)
        toast('验证脚本加载失败，请检查网络')
        setShowVerify(false)
      } else if (d.type === 'captcha_fail') {
        console.log('[KgLogin] 验证失败, ret=', d.ret, 'desc=', d.desc)
        toast('验证失败: ' + (d.desc || '请重试'))
        setShowVerify(false)
      } else {
        console.log('[KgLogin] 未知回调类型:', d.type)
        setShowVerify(false)
      }
    } catch (err) { console.error('[KgLogin] handleVerifyMsg error:', err); setShowVerify(false) }
  }, [])

  const handleSendCode = useCallback(async() => {
    if (!phone || phone.length < 11) { toast('请输入正确的手机号'); return }
    if (cooldown > 0) { toast('请稍后再试'); return }
    setSending(true)
    try {
      const result = await sendCaptcha(phone, () => {})
      console.log('[KgLogin] sendCaptcha result:', JSON.stringify(result))
      if (result.success) {
        console.log('[KgLogin] 验证码发送成功')
        toast('验证码已发送'); let s = 60; setCountdown(s)
        timerRef.current = setInterval(() => { s--; setCountdown(s); if (s <= 0 && timerRef.current) { clearInterval(timerRef.current); timerRef.current = null } }, 1000)
      } else if (result.ssaCode) {
        console.log('[KgLogin] 需要滑块验证, ssaCode:', result.ssaCode)
        const vr = await getVerifyInfo(result.ssaCode)
        if (vr.success && vr.data?.txappid) { setVerifyHtml(generateVerifyHtml(vr.data.txappid, result.ssaCode)); setShowVerify(true) } else { console.log('[KgLogin] getVerifyInfo failed:', vr.message); toast('获取验证信息失败') }
      } else { console.log('[KgLogin] sendCaptcha failed:', result.message); toast(result.message || '发送验证码失败') }
    } catch (err: any) { console.error('[KgLogin] sendCaptcha error:', err); toast('发送验证码失败: ' + (err.message || '')) } finally {
      setSending(false); setCooldown(2)
      cdRef.current = setInterval(() => { setCooldown(p => { if (p <= 1) { if (cdRef.current) { clearInterval(cdRef.current); cdRef.current = null }; return 0 }; return p - 1 }) }, 1000)
    }
  }, [phone, cooldown])
  sendRef.current = () => { void handleSendCode() }

  const handleMultiLogin = useCallback(async(userId: string) => {
    if (!pendingData) return; setShowMultiAccount(false); setLogging(true)
    try {
      const r = await loginByPhone(pendingData.mobile, pendingData.code, () => {}, userId)
      if (r.success && r.data) { (global.app_event as any).emit('kg-cookie-set', buildCookieString(r.data)); toast('登录成功！'); handleClose() } else toast(r.message || '登录失败')
    } catch { toast('登录失败') } finally { setLogging(false); setPendingData(null) }
  }, [pendingData, handleClose])

  const handleLogin = useCallback(async() => {
    if (!phone || phone.length < 11) { toast('请输入正确的手机号'); return }
    if (!code || code.length < 4) { toast('请输入验证码'); return }
    setLogging(true)
    try {
      const r = await loginByPhone(phone, code, () => {})
      if (r.success && r.data) { (global.app_event as any).emit('kg-cookie-set', buildCookieString(r.data)); toast('登录成功！'); handleClose() } else if (r.message?.includes('34175')) { setPendingData({ mobile: phone, code }); setShowMultiAccount(true) } else toast(r.message || '登录失败')
    } catch { toast('登录失败') } finally { setLogging(false) }
  }, [phone, code, handleClose])

  return (
    <Modal ref={modalRef} statusBarPadding={false} bgHide={false} bgColor="rgba(0,0,0,0.5)">
      <View style={styles.container}>
        <View style={[styles.header, { height: 56 + useStatusbarHeight(), paddingTop: useStatusbarHeight(), backgroundColor: theme['c-content-background'] }]}>
          <TouchableOpacity
            onPress={handleClose}
            style={[
              styles.backBtn,
              // 无固定高度：以可见高度 42（图标 26 + 上下 padding 各 8）作依据
              { borderRadius: buttonRadius(42) },
            ]}
          ><Icon name="chevron-left" size={26} color={theme['c-font']} /></TouchableOpacity>
          <Text size={18}>登录</Text>
          <View style={{ width: 44 }} />
        </View>
        <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
          <Text size={15} style={[styles.smsTitle, { color: theme['c-font'] }]}>使用手机短信验证码登录</Text>
          <View style={[styles.inputRow, { borderBottomColor: (theme as any)['c-border'] }]}>
            <Text size={15} color={theme['c-font']}>+86  |  </Text>
            <TextInput style={[styles.input, { color: theme['c-font'] }]} placeholder="手机号" placeholderTextColor={theme['c-font-label']} keyboardType="phone-pad" value={phone} onChangeText={setPhone} maxLength={11} editable={!logging} />
            {phone.length > 0 && <TouchableOpacity onPress={() => { setPhone('') }} style={{
              // 无固定高度：以图标本体 18（Icon size=18）作可见高度
              borderRadius: buttonRadius(18),
            }}><Icon name="close" size={18} color={theme['c-font-label']} /></TouchableOpacity>}
          </View>
          <View style={[styles.inputRow, { borderBottomColor: (theme as any)['c-border'] }]}>
            <TextInput style={[styles.input, { color: theme['c-font'] }]} placeholder="验证码" placeholderTextColor={theme['c-font-label']} keyboardType="number-pad" value={code} onChangeText={setCode} maxLength={6} editable={!logging} />
            <TouchableOpacity
              onPress={handleSendCode}
              disabled={countdown > 0 || sending || cooldown > 0 || logging}
              style={{
                // 无固定高度：以 14 号字默认行高 ≈ 16（14 × 1.15，Text 全局行高基线）作可见高度
                borderRadius: buttonRadius(16),
              }}
            >
              <Text size={14} color={countdown > 0 || cooldown > 0 ? theme['c-font-label'] : '#1677ff'}>{countdown > 0 ? `${countdown}s` : sending ? '发送中...' : cooldown > 0 ? '请稍候' : '获取验证码'}</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={[styles.loginBtn, {
            // 固定品牌色，不跟随「按钮透明度」（否则透明度=0 时白底白字，按钮整块消失）
            backgroundColor: logging ? KG_BRAND_BUSY : KG_BRAND,
            // 可见高度 ≈ 46 = 16 号字默认行高 18（16 × 1.15）+ 上下 padding 14×2，行内覆盖「按钮圆角」
            borderRadius: buttonRadius(46),
          }]} onPress={handleLogin} disabled={logging}>
            <Text size={16} color="#fff">{logging ? '登录中...' : '登录'}</Text>
          </TouchableOpacity>
          <Text size={12} color={theme['c-font-label']} style={styles.smsTip}>手机号仅用于酷狗音乐官方发送验证码与登录接口，不予保存；{'\n'}本地仅存储登录凭证。</Text>
        </ScrollView>

        {showVerify && verifyHtml ? (
          <View style={styles.verifyOverlay}>
            <View style={styles.verifyBox}>
              <WebView source={{ html: verifyHtml }} onMessage={handleVerifyMsg} style={{ flex: 1 }} javaScriptEnabled domStorageEnabled useWebKit cacheEnabled={false} incognito nestedScrollEnabled overScrollMode="never" bounces={false} setSupportMultipleWindows={false} allowsFullscreenVideo mediaPlaybackRequiresUserAction={false} />
            </View>
          </View>
        ) : null}

        {/* multiAccountMounted 同 common/Modal 的延迟卸载口径：本组件是全工程里
            仅剩的一处绕过卸载规避的原生 Modal（多账号选择框）。它嵌在安全的
            <Modal> 内、宿主生命周期已被外层兜住，但残留宿主吞触摸的机制与
            StylizedModal 完全同类，故按同一口径补齐（隐藏后 300ms 卸载）。 */}
        {multiAccountMounted ? (
          <RNModal visible={showMultiAccount} transparent animationType="fade" onRequestClose={() => { setShowMultiAccount(false) }}>
            <View style={styles.modalOverlay}>
              <View style={[styles.modalBox, { backgroundColor: '#fff' }]}>
                <Text size={16} style={{ textAlign: 'center', marginBottom: 16, color: theme['c-font'] }}>该手机号绑定了多个账号</Text>
                <View style={[styles.idInput, { borderBottomColor: (theme as any)['c-border'] }]}>
                  <TextInput style={[styles.idInputText, { color: theme['c-font'] }]} placeholder="请输入您要登录的酷狗ID" placeholderTextColor={theme['c-font-label']} value={selectedId} onChangeText={setSelectedId} keyboardType="number-pad" autoFocus />
                </View>
                <TouchableOpacity style={[styles.modalBtn, {
                  // 固定品牌色，不跟随「按钮透明度」；未填 ID 的禁用态给浅蓝但文字仍可见
                  backgroundColor: selectedId.trim() ? KG_BRAND : KG_BRAND_BUSY,
                  marginTop: 20,
                  // 可见高度 ≈ 46（依据同登录按钮：16 号字默认行高 18 + 上下 padding 14×2）
                  borderRadius: buttonRadius(46),
                }]} onPress={async() => handleMultiLogin(selectedId)} disabled={!selectedId.trim()} activeOpacity={0.8}>
                  <Text size={16} color="#fff">确定登录</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.modalBtn, {
                  // 次要按钮用固定浅灰底 + 深灰字：原来借 theme['c-border'] 配白字，
                  // 浅色主题下底色本身就接近白，字完全看不见（与按钮透明度无关的老问题）
                  backgroundColor: KG_NEUTRAL_BG,
                  marginTop: 10,
                  // 可见高度 ≈ 46（依据同登录按钮：16 号字默认行高 18 + 上下 padding 14×2）
                  borderRadius: buttonRadius(46),
                }]} onPress={() => { setShowMultiAccount(false); setPendingData(null); setSelectedId('') }} activeOpacity={0.8}>
                  <Text size={16} color={KG_NEUTRAL_FG}>取消</Text>
                </TouchableOpacity>
              </View>
            </View>
          </RNModal>
        ) : null}
      </View>
    </Modal>
  )
})

export default KgWebLoginModal

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  backBtn: { padding: 8, width: 44, alignItems: 'center', justifyContent: 'center' },

  smsTitle: { textAlign: 'center', marginTop: 20, marginBottom: 20, fontWeight: '500' },
  inputRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, paddingVertical: 14, marginHorizontal: 20 },
  input: { flex: 1, fontSize: 15, padding: 0 },
  loginBtn: { marginTop: 30, marginHorizontal: 20, paddingVertical: 14, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  smsTip: { textAlign: 'center', marginTop: 20, lineHeight: 16, paddingHorizontal: 20 }, // A-6：离群行高收敛 18→16
  verifyOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  verifyBox: { width: '90%', height: 350, borderRadius: 16, overflow: 'hidden', backgroundColor: '#fff' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  modalBox: { width: '80%', borderRadius: 16, padding: 24, backgroundColor: '#fff' },
  idInput: { borderBottomWidth: 1, paddingVertical: 14, marginTop: 8 },
  idInputText: { fontSize: 15, padding: 0 },
  modalBtn: { paddingVertical: 14, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
})
