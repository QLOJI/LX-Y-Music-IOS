// QQ 音乐网页端写接口的 AG1 通道（needSign）：
//   · 请求体：JSON → AES-128-GCM（随机 12 字节 IV）→ base64(iv || ciphertext || tag)
//   · 响应体：每个字节与固定 key 循环 XOR
// 明文通道对「我喜欢」会返回业务码 80105（retCode 仍可能是 0）且不落库，
// 必须用这套加密通道。算法来源 @jixun/qmweb-sign（MIT）。
import forge from 'node-forge'

const REQUEST_KEY = [189, 48, 95, 16, 208, 255, 116, 182, 239, 84, 218, 184, 53, 181, 225, 207]
const RESPONSE_KEY = [
  122, 63, 140, 29, 94, 155, 47, 10, 108, 77, 126, 139, 31, 58, 92, 157, 14, 43, 111, 74, 129,
]

const toBinaryString = (bytes) => {
  let str = ''
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i])
  return str
}

/** JSON 文本 → base64(iv + ciphertext + tag)，可直接作为 text/plain 请求体。 */
export const encodeAG1Request = (text) => {
  const iv = forge.random.getBytesSync(12)
  const cipher = forge.cipher.createCipher('AES-GCM', toBinaryString(REQUEST_KEY))
  cipher.start({ iv })
  cipher.update(forge.util.createBuffer(forge.util.encodeUtf8(String(text ?? ''))))
  if (!cipher.finish()) throw new Error('AG1 请求加密失败')
  const tag = cipher.mode.tag ? cipher.mode.tag.getBytes() : ''
  return forge.util.encode64(iv + cipher.output.getBytes() + tag)
}

/** 响应原始字节 → JSON 文本（逐字节 XOR，非 fatal UTF-8 解码）。 */
export const decodeAG1Response = (data) => {
  const src = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const out = Buffer.alloc(src.length)
  for (let i = 0; i < src.length; i++) out[i] = src[i] ^ RESPONSE_KEY[i % RESPONSE_KEY.length]
  return out.toString('utf8')
}
