import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { agentApi } from './vite-plugins/agent-api.ts';

// https://vite.dev/config/
export default defineConfig({
    plugins: [react(), tailwindcss(), agentApi()],
    server: {
        port: 5180,
        host: true,
    },
});
