global.Buffer = require('buffer').Buffer

// Release 兜底：即使构建流程没有走到 babel 的 console 剥离，也不要把调试日志
// 每条都送进原生控制台（warn/error 保留）。开发包不受影响。
if (typeof __DEV__ !== 'undefined' && !__DEV__) {
  console.log = () => {}
  console.info = () => {}
  console.debug = () => {}
  console.trace = () => {}
}
