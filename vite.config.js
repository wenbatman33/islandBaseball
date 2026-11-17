import { defineConfig } from 'vite';

// 三個頁面：遊戲本體（index.html）、球員一覽（lineup.html）、大聯盟球員分析（mlb-lab.html，獨立分析用）
export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: 'index.html', lineup: 'lineup.html', mlbLab: 'mlb-lab.html' },
    },
  },
});
