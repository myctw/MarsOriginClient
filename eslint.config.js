// ESLint 設定 (執行:npm run lint)
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        ignores: ['node_modules/**', 'db/**', 'misc/**', 'assets/**', 'doc/**', 'src/area/**', '.claude/**', 'index.html']
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: { ...globals.node }
        },
        rules: {
            // == 只允許用在和 null 比較 (同時涵蓋 undefined);其他一律 ===
            // 例:之前的 `!player.class == 4` 永遠不成立
            // 既有程式中還沒確認型別的 (多半是房間/物品 id,可能一邊數字一邊字串,直接改 === 會改變結果)
            // 逐行標了 `eslint-disable-next-line eqeqeq -- 待確認型別`,搜尋這段文字即可找到
            eqeqeq: ['error', 'smart'],
            'no-var': 'error',
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }]
        }
    },
    {
        // 測試常需要用控制字元比對、去除 ANSI 色碼
        files: ['tests/**/*.js'],
        rules: { 'no-control-regex': 'off' }
    }
];
