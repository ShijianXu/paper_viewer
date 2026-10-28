import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development, `npm run dev` serves the UI and forwards API calls to the backend.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
})
