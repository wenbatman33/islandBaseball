import { defineConfig } from 'vite';

// 兩個頁面：遊戲本體（index.html）與球員一覽（lineup.html）
export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: 'index.html', lineup: 'lineup.html' },
    },
  },
});
