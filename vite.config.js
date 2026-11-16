import { defineConfig } from 'vite';

// 三個頁面：遊戲本體（index.html）、球員模型檢視頁（viewer.html）、球員一覽（lineup.html）
export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: 'index.html', viewer: 'viewer.html', lineup: 'lineup.html' },
    },
  },
});
