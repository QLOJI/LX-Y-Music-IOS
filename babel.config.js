// Release 构建去掉 console.log/info/debug/trace：这些字符串拼接与参数格式化在
// 网络、搜索、用户源等高频路径里反复执行，生产包既看不见也没有功能用途。
// 保留 warn/error，线上排障与错误上报不受影响；开发包原样保留所有日志。
const stripConsolePlugin = ({ types: t }) => ({
  name: 'lx-strip-console',
  visitor: {
    CallExpression(path) {
      const callee = path.node.callee
      if (!t.isMemberExpression(callee)) return
      if (!t.isIdentifier(callee.object, { name: 'console' })) return
      if (!t.isIdentifier(callee.property)) return
      if (!['log', 'info', 'debug', 'trace'].includes(callee.property.name)) return
      if (path.parentPath.isExpressionStatement()) {
        path.parentPath.remove()
      } else {
        path.replaceWith(t.unaryExpression('void', t.numericLiteral(0)))
      }
    },
  },
})

module.exports = (api) => {
  const isProduction = api.env('production')
  return {
    presets: ['module:@react-native/babel-preset'],
    plugins: [
      {
        visitor: {
          ImportDeclaration(path) {
            if (
              path.node.source.value === 'react/jsx-runtime' &&
              !(path.hub.file.opts.filename || '').endsWith('jsxRuntimeProbe.ts')
            ) {
              path.node.source.value = '@/utils/jsxRuntimeProbe'
            }
          },
        },
      },
      '@babel/plugin-proposal-export-namespace-from',
      [
        'module-resolver',
        {
          root: ['.'],
          extensions: [
            '.android.ts',
            '.ios.ts',
            '.android.tsx',
            '.ios.tsx',
            '.tsx',
            '.ts',
            '.android.js',
            '.ios.js',
            '.android.jsx',
            '.ios.jsx',
            '.jsx',
            '.js',
            '.json',
          ],
          alias: {
            '@': './src',
            // '@config': './src/config',
            // '@store': './src/store',
            // '@components': './src/components',
            // '@navigation': './src/navigation',
            // '@screens': './src/screens',
            // '@theme': './src/theme',
          },
        },
      ],
      ...(isProduction ? [stripConsolePlugin] : []),
    ],
  }
}
