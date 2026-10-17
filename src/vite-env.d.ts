/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** токен прод-мутаций Agent API; должен совпадать с LAB_API_TOKEN на сервере (собирается в бандл — только для закрытых инстансов) */
    readonly VITE_LAB_TOKEN?: string;
    /** базовый URL агентского API вместо same-origin /api (standalone lab-sync, включает /api — например https://sync.lkv.net.ru/api) */
    readonly VITE_SYNC_BASE?: string;
}
