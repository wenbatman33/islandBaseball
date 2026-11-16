import { defineConfig } from 'vite';

// 兩個頁面：遊戲本體（index.html）與球員模型檢視頁（viewer.html）
export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: 'index.html', viewer: 'viewer.html' },
    },
  },
});
